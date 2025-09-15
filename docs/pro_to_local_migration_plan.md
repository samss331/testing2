# Ternary Pro → Local Engine Migration Plan

This document details how to migrate Smart Context and Turbo Edits from the remote Ternary Engine into a fully local implementation inside the app repository.

## Executive Summary

- Today, when Ternary Pro is enabled and certain modes are on, the app uses a remote Engine to:
  - Select Smart Context files for requests (Smart Context).
  - Generate fast full-file updates (Turbo/Lazy Edits).
- We will replace these Engine responsibilities with local logic in the main process so the app remains closed-source but independent of remote server behavior.
- Key integration points:
  - `src/ipc/utils/get_model_client.ts` (current Engine/gateway plumbing)
  - `src/ipc/handlers/chat_stream_handlers.ts` (request assembly, streaming, post-processing)
  - `src/utils/codebase.ts` (codebase scanning and formatting)
  - Context UI and IPC: `src/components/ContextFilesPicker.tsx`, `src/hooks/useContextPaths.ts`, `src/ipc/handlers/context_paths_handlers.ts`

## Current Architecture (What’s There Now)

- Context management

  - UI/IPC data flows:
    - UI: `ContextFilesPicker.tsx` allows manual include/exclude and auto-include patterns stored per-app.
    - IPC: `context_paths_handlers.ts` reads/writes `AppChatContext` in the DB and calculates tokens/files using `extractCodebase`.
    - Validation: `context_paths_utils.ts` validates context shape.
  - Codebase extraction: `src/utils/codebase.ts#extractCodebase()` scans the repo, applies include/exclude/auto-include, omits some files, and returns:
    - `formattedOutput`: XML-like `<ternary-file>` blocks
    - `files`: array of `{ path, content, force? }` used as file list payload
  - Smart Context flagging exists only as simple gating of auto-includes and omission rules. The “relevance selection” of files is not implemented locally.

- Chat pipeline

  - `registerChatStreamHandlers()` assembles the prompt, extracts codebase via `extractCodebase`, computes system prompt, and calls `getModelClient()`.
  - If `getModelClient()` returns `isEngineEnabled=true`, the app:
    - Skips the codebase pre-prompt because the Engine is expected to apply files.
    - Sends `files` to the Engine via OpenAI-compatible JSON payload (`ternary_options.files`).
  - Otherwise, it prepends the codebase preamble in the conversation (`createCodebasePrompt(...)`).

- Engine/Gateway plumbing

  - `get_model_client.ts` decides whether to use:
    - A provider client directly (OpenAI/Google/etc), or
    - Ternary Pro gateway, or
    - Ternary Engine (via `createTernaryEngine()`), when Pro and certain modes are enabled.
  - `llm_engine_provider.ts` injects `ternary_options` with flags:
    - `enable_lazy_edits`, `enable_smart_files_context`, `smart_context_mode`
    - and attaches the `files` array.

- Turbo edits UI

  - `src/components/chat/TernaryEdit.tsx` renders `<ternary-edit>` blocks. There’s no local logic to produce turbo edits—this was delegated to Engine behavior.

- Tests
  - `e2e-tests/engine.spec.ts` focuses on “send message to engine” and snapshots requests.
  - `e2e-tests/smart_context_options.spec.ts` checks UI state changes for Smart Context options.

## Gaps To Fill Locally

1. Smart Context Relevance Selection

   - Missing: a local scoring/selection step to pick most relevant files based on the current prompt/chat.
   - Today: only manual context + auto-includes + excludes + omission heuristics.

2. Turbo Edits Local Generation

   - Missing: a local pipeline to detect `<ternary-edit>` tasks and dispatch a cheaper/faster model to produce full-file updates.

3. Removal of Engine dependency
   - `get_model_client.ts` should not pivot request path and provider behavior based on Engine presence.
   - `llm_engine_provider.ts` should be deprecated or made no-op.

## Proposed Local Smart Context Engine

Create a new module `src/ipc/utils/smart_context_engine.ts` with the following responsibilities:

- Input

  - `appPath: string`
  - `chatContext: AppChatContext` (manual include/exclude/auto-include)
  - `promptContext: { userPrompt: string; recentMessages: {role, content}[] }`
  - `mode: "off" | "conservative" | "balanced"`
  - `tokenBudget?: number` (derived from model and settings)

- Output

  - `{ selectedFiles: { path: string; content: string; force?: boolean }[]; debug: { candidates: number; selected: number; reason: string } }`

- Algorithm

  - Reuse `extractCodebase` to get candidate files and file contents quickly, but run in a “candidate harvest” mode:
    - Respect `excludePaths`.
    - Always merge `smartContextAutoIncludes` into `selectedFiles` (flag `force=true`).
    - Generate initial candidate set by scanning allowed extensions and allowed size (already in `codebase.ts`).
  - Scoring strategies (in order of availability):
    - Embedding similarity (optional, configurable):
      - Use selected provider embeddings (OpenAI/Vertex/Local) if configured.
      - Cache file embeddings on disk keyed by hash/mtime to avoid recomputation.
      - Score by cosine similarity vs. combined query embedding (user prompt + recent user messages).
    - TF-IDF fallback:
      - Tokenize per file content (respect size cap) and compute TF-IDF vectors in-memory.
      - Cosine similarity vs. query vector.
    - Heuristic boosters:
      - Path/name contains keywords from the prompt.
      - Recent edits (by mtime) get a small boost.
  - Selection policy per mode:
    - off: Return full-codebase behavior (respect legacy omission rules) or fallback to manual context only.
    - conservative: Select top-K where K is small (e.g., 10–30 files) within token budget.
    - balanced: Select larger K (e.g., 50–200 files) within token budget.
  - Token budgeting:
    - Use `getMaxTokens()` minus headroom for model output and system instructions to compute allowance for file context.
    - Pack files until budget is nearly exhausted; keep auto-includes in regardless of ranking.

- Integration Points

  - In `registerChatStreamHandlers()` after computing `chatContext` and before `getModelClient()`:
    - If Smart Context is enabled: call `smart_context_engine.select(...)`.
    - Replace the previous `extractCodebase` preamble with the selected files.
    - Always use the local pre-prompt path (no Engine bypass) or (option B) attach files directly into the conversation as preamble blocks.
  - Keep `ContextFilesPicker` UX unchanged.

- Telemetry/Logging
  - Log number of candidates, selected count, token estimation, and top reasons (debug string) to `electron-log`.

## Proposed Local Turbo Edits Engine

Create `src/ipc/utils/turbo_edits_engine.ts` with the following responsibilities:

- Input

  - `fullResponse: string` (the streamed assistant output)
  - `appPath: string`
  - `settings: UserSettings`
  - `modelClientFactory: (modelSpec) => LanguageModelV2` to call a cheaper model

- Output

  - Updated assistant content where `<ternary-edit>` blocks have full file contents generated, streamed/incrementally updated back to UI.

- Flow

  1. During streaming in `registerChatStreamHandlers()`:
     - Buffer assistant text normally.
     - Detect when a `<ternary-edit path="..." description="...">` tag starts.
     - Mark it as pending in UI (`state="pending"`).
  2. After main stream completes or when a block is closed:
     - For each detected edit block, spawn a secondary generation task using a cheaper model (e.g., Gemini Flash / GPT-mini) with a focused prompt that includes:
       - The target file’s current content.
       - The system rules for `ternary-edit` format.
       - The user’s latest instruction.
     - Stream the generated content into the block.
     - Update UI state to done/aborted based on completion.
  3. Safety and limits:
     - Cap turbo edit output tokens.
     - If turbo task fails, mark block as aborted with an error message but preserve main response.

- Configuration

  - Add settings to choose the “fast model” used for turbo edits. Default to a cheap model on the same provider (where available) or the user’s configured smallest model.
  - Respect `enableProLazyEditsMode` and disable in `ask` mode.

- Application of Edits
  - Edits remain suggestions until the user approves. When approved, the existing response processor applies the edits.

## Refactors To Remove Engine Dependency

- `src/ipc/utils/get_model_client.ts`

  - Remove the special-case Engine branch (`createTernaryEngine`) and `isEngineEnabled` return flag.
  - Keep support for Ternary Gateway as a normal OpenAI-compatible provider when API key is present, but do not send `ternary_options` or `files`.
  - Ensure all models run through a single path that returns `{ modelClient }` with `builtinProviderId` only.

- `src/ipc/utils/llm_engine_provider.ts`

  - Deprecate. Keep as a thin adapter or delete once call sites are removed. Do not inject `ternary_options`.

- `src/ipc/handlers/chat_stream_handlers.ts`

  - Always use the local Smart Context Engine result:
    - Either embed file context as preamble (existing behavior when Engine was off), or
    - Optionally attach selected files inline as XML blocks (consistent with `createCodebasePrompt`).
  - Plug in Turbo Edits Engine after the main stream, as an optional enrichment step when enabled.

- Settings and UI
  - `ProModeSelector.tsx` remains unchanged externally. Internally, modes now toggle local engines.

## Detailed Implementation Steps

1. Create Smart Context Engine

   - [ ] New file: `src/ipc/utils/smart_context_engine.ts`
   - [ ] Implement candidate harvest using `extractCodebase` and then re-score via:
     - [ ] Optional embedding provider (cache on disk by `path + mtime`)
     - [ ] TF-IDF fallback
     - [ ] Heuristic boosters
   - [ ] Implement selection packing by token budget and mode.

2. Integrate Smart Context locally

   - [ ] Modify `registerChatStreamHandlers()`:
     - [ ] Collect `promptContext` from `req.prompt` and recent user messages.
     - [ ] If Smart Context enabled, call `smart_context_engine.select(...)`.
     - [ ] Create `codebasePrefix` messages from selected files (always), remove the Engine skip branch.

3. Remove Engine-dependence in model client

   - [ ] Update `get_model_client.ts`:
     - [ ] Remove `createTernaryEngine` usage and the `isEngineEnabled` switching.
     - [ ] Keep gateway provider as standard OpenAI-compatible without `ternary_options`.

4. Implement Turbo Edits Engine

   - [ ] New file: `src/ipc/utils/turbo_edits_engine.ts`
   - [ ] Add detection of `<ternary-edit>` tags in streamed text and maintain block state.
   - [ ] After main stream, spawn secondary generation tasks per block using a cheap model.
   - [ ] Stream updates back to UI via existing chunk update mechanism.

5. Wire Turbo Edits into chat flow

   - [ ] In `registerChatStreamHandlers()` after `processStreamChunks`, call turbo edits pipeline when `enableProLazyEditsMode`.
   - [ ] Provide configuration and defaults for the fast model selection.

6. Logging and observability

   - [ ] Add debug logs around selection sizes, token usage, and turbo edits statuses.

7. Backwards compatibility / flags
   - [ ] Maintain current settings flags (`enableTernaryPro`, `enableProSmartFilesContextMode`, `proSmartContextOption`, `enableProLazyEditsMode`).
   - [ ] Add a hidden env flag to re-enable Engine path for emergency fallback (optional).

## Testing Strategy

- Unit Tests

  - Smart Context Engine
    - [ ] Ranking correctness with known synthetic corpora.
    - [ ] Token packing respects budget and auto-includes precedence.
    - [ ] Embedding cache hit/miss behavior.
  - Turbo Edits Engine
    - [ ] Proper detection of `<ternary-edit>` blocks.
    - [ ] Secondary model invocation and error handling.

- E2E Tests

  - Update existing
    - [ ] `e2e-tests/smart_context_options.spec.ts`: behavior remains the same (UI state only).
    - [ ] Replace `e2e-tests/engine.spec.ts` with local-engine tests:
      - “send message with turbo edits” verifies `<ternary-edit>` blocks get populated locally; no remote engine call made.
      - Conservative mode test to snapshot selected file count or a diagnostic dump (add a debug IPC endpoint for test to pull the last selection summary).
  - New E2E Scenarios
    - [ ] Large codebase: balanced vs. conservative mode selects different counts and stays within token budget.
    - [ ] Auto-includes always present even if low scoring.
    - [ ] Excludes take precedence.

- Test Fixtures
  - [ ] Add a `fixtures/smart-context/` project with known relevant files.
  - [ ] Use an embedded fake provider or a fake streaming provider to deterministically produce `<ternary-edit>` content for turbo tests.

## Rollout Plan

1. Implement Smart Context locally and flip chat flow to always use local preamble.
2. Remove Engine path in `get_model_client.ts` and ship behind a short-lived feature flag.
3. Implement Turbo Edits local engine and ship disabled by default; enable in Pro UI after validation.
4. Update documentation and release notes.

## Risks and Mitigations

- Cost/perf regressions without Engine optimizations
  - Mitigation: conservative mode defaults; TF-IDF fallback; embedding cache; small fast-model for turbo edits.
- Behavioral changes in output
  - Mitigation: snapshot baselines and write precise regression tests.
- Provider variance for embeddings/cheap models
  - Mitigation: optional per-provider default mappings and ability to override in settings.

## File-by-File Change List

- New

  - `src/ipc/utils/smart_context_engine.ts`
  - `src/ipc/utils/turbo_edits_engine.ts`

- Modified

  - `src/ipc/handlers/chat_stream_handlers.ts`
    - Call local Smart Context selection; integrate Turbo Edits post-processing
  - `src/ipc/utils/get_model_client.ts`
    - Remove Engine path and `isEngineEnabled` branching
  - Optionally remove or noop
    - `src/ipc/utils/llm_engine_provider.ts`

- Tests
  - `e2e-tests/engine.spec.ts` → rename and repurpose to local engine coverage
  - Add unit tests under `src/__tests__/` for Smart Context and Turbo Edits

## Open Questions

- Do we want to embed files as preamble (current Engine-off behavior) vs. a second structured mechanism? Preamble keeps compatibility with existing prompts and UI.
- Which provider embeddings to support out-of-the-box? Proposal: OpenAI, Vertex, local (ollama) when configured; otherwise TF-IDF fallback.
- Provide a UI toggle for “Use embeddings for Smart Context” or keep it automatic when configured?

## Pro Features Auth Refactor Wireframe: Deeplink API Key → Device Linking

This section outlines the plan to transition the Pro features enablement from a deeplink-delivered API key to a device linking flow. The website folder already contains scaffolding for device linking; here we define the app-side architecture and integration.

### Current Mechanism (Deeplink Key)

- App receives a deeplink containing an API key.
- Key is stored in settings and used by `get_model_client.ts` for gateway/engine calls.
- Pro toggles (e.g., `enableTernaryPro`) assume the key is present and valid.

### Target Architecture (Device Linking)

- The device initiates a linking request and receives a short-lived link code (displayed in-app) and a deviceLinkId.
- User visits the website, logs in, and approves the device using the code.
- App polls (or subscribes via SSE/Websocket) using deviceLinkId until approval.
- On approval, the server returns an access bundle tailored for close-source local features:
  - Access token or signed capability specific to this device.
  - Expiry and refresh token (if applicable).
  - Optional quota info for UX (credits, reset dates), but not required for local engines.
- App stores the device credentials securely (settings or OS keychain).
- Pro features toggle based on the presence and validity of device credentials, not a generic API key.

### Data Flow

1. Renderer (Settings/Pro dialog) → Main via IPC: `pro:device-link:start`
2. Main → Website API: create link session → returns `{ deviceLinkId, linkCode, expiresAt }`
3. Main → Renderer: show `linkCode` and countdown
4. Main polls `pro:device-link:status` against Website API (or opens SSE)
5. On approval, API returns `{ deviceAccessToken, refreshToken?, expiresAt }`
6. Main persists credentials and updates settings: `enableTernaryPro=true`
7. Renderer updates UI state and hides linking UI.

### IPC Endpoints (Main)

- `pro:device-link:start` → `{ deviceLinkId, linkCode, expiresAt }`
- `pro:device-link:status` → `{ status: "pending" | "approved" | "expired", expiresAt }`
- `pro:device-link:finalize` (optional if status returns credentials) → stores `{ deviceAccessToken, refreshToken?, expiresAt }`
- `pro:device-link:unlink` → revoke and delete stored credentials
- `pro:credentials:get` → returns minimal, redacted state for UI (e.g., `{ linked: true, expiresAt }`)

### Renderer/UI Changes

- New UI in `ProModeSelector.tsx` (or a dedicated modal) for device linking:
  - Start Linking → shows code and QR link (website has scaffold)
  - Pending state with timer; “I’ve approved” to re-check
  - Linked state with expiry and unlink action
- Settings schema additions:
  - `proDeviceCredentials?: { tokenMeta: { expiresAt: Date }, lastLinkedAt: Date }`
  - Do not expose the token to renderer; main holds the sensitive value.

### Storage and Security

- Prefer OS keychain/credential vault if feasible; otherwise encrypt at rest.
- Expose only linkage state to renderer; never the raw token.
- Rotate/refresh on expiry; schedule background refresh job.
- Handle logout/unlink by revoking token and deleting local secrets.

### Integration With Local Engine Plan

- Since Smart Context and Turbo Edits are local, tokens are no longer used to call a remote engine.
- Optional: keep a lightweight gateway usage (if any) gated behind device credentials; otherwise, Pro simply toggles local features.
- Replace any `hasTernaryProKey(settings)` checks with `hasProDeviceLink(settings)` semantics.

### Migration Strategy

- Detect legacy deeplink key on startup:
  - Show a one-time banner prompting user to link device.
  - Keep legacy path working for one or two versions behind a feature flag.
  - Provide a migration action: “Link this device” which, on success, removes the old key.

### Telemetry/Observability

- Log link start, approval, expiry events (no PII).
- Provide a debug view (hidden dev menu) to show link state, next refresh, and last error.

### Testing Plan

- Unit tests
  - IPC handlers for start/status/finalize/unlink
  - Secure storage facade
- E2E tests
  - Mock website endpoints in test server
  - Link happy path, expiry path, unlink flow
- Manual QA
  - Verify UI states and persistence across restarts

### Step-by-Step Refactor Plan

1. Backend (main process)
   - Add `pro_device_link_handlers.ts` with the IPC endpoints above.
   - Add `secure_storage.ts` abstraction for credentials.
   - Add `pro_link_client.ts` to talk to website link endpoints.
2. Renderer
   - Extend Pro dialog to support linking UX.
   - Replace key presence checks with device link presence checks.
3. Settings/Schema
   - Add non-sensitive linkage metadata fields.
4. Cleanup
   - Mark legacy deeplink key paths deprecated; add migration notice.
5. Rollout
   - Ship behind a feature flag for one version, then default on.
