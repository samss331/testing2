import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import log from "electron-log";
import { extractCodebase, type CodebaseFile } from "@/utils/codebase";
import { estimateTokens } from "./token_utils";
import { getMaxTokens } from "./token_utils";
import type {
  AppChatContext,
  UserSettings,
  LargeLanguageModel,
} from "@/lib/schemas";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { embed } from "ai";
import { getEnvVar } from "./read_env";

const logger = log.scope("smart_context_engine");

// Cache directory for embeddings
const CACHE_DIR = path.join(process.cwd(), ".ternary", "embeddings-cache");

export interface SmartContextOptions {
  appPath: string;
  chatContext: AppChatContext;
  promptContext: {
    userPrompt: string;
    recentMessages: Array<{ role: string; content: string }>;
  };
  mode: "off" | "conservative" | "balanced";
  model: LargeLanguageModel;
  settings: UserSettings;
  tokenBudget?: number;
}

export interface SmartContextResult {
  selectedFiles: CodebaseFile[];
  debug: {
    totalCandidates: number;
    selectedCount: number;
    tokenUsage: number;
    tokenBudget: number;
    scoringMethod: string;
    topScores: Array<{ path: string; score: number; reason: string }>;
    autoIncludesCount: number;
    excludedCount: number;
  };
}

interface FileCandidate extends CodebaseFile {
  score: number;
  reasons: string[];
  isAutoInclude: boolean;
  tokens: number;
}

interface EmbeddingCacheData {
  embedding: number[];
  hash: string;
  mtime: number;
}

// TF-IDF implementation
class TFIDFScorer {
  private documents: Array<{ path: string; tokens: string[] }> = [];
  private vocabulary: Set<string> = new Set();
  private idfCache: Map<string, number> = new Map();

  constructor(files: CodebaseFile[]) {
    // Tokenize all documents
    for (const file of files) {
      const tokens = this.tokenize(file.content);
      this.documents.push({ path: file.path, tokens });
      tokens.forEach((token) => this.vocabulary.add(token));
    }

    // Compute IDF for all terms
    this.computeIDF();
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && token.length < 50)
      .filter((token) => !this.isStopWord(token));
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "up",
      "about",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "among",
      "this",
      "that",
      "these",
      "those",
      "i",
      "me",
      "my",
      "myself",
      "we",
      "our",
      "ours",
      "ourselves",
      "you",
      "your",
      "yours",
      "yourself",
      "yourselves",
      "he",
      "him",
      "his",
      "himself",
      "she",
      "her",
      "hers",
      "herself",
      "it",
      "its",
      "itself",
      "they",
      "them",
      "their",
      "theirs",
      "themselves",
      "what",
      "which",
      "who",
      "whom",
      "this",
      "that",
      "these",
      "those",
      "am",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "having",
      "do",
      "does",
      "did",
      "doing",
      "will",
      "would",
      "should",
      "could",
      "can",
      "may",
      "might",
      "must",
      "shall",
    ]);
    return stopWords.has(word);
  }

  private computeIDF(): void {
    const totalDocs = this.documents.length;

    for (const term of this.vocabulary) {
      const docsWithTerm = this.documents.filter((doc) =>
        doc.tokens.includes(term),
      ).length;

      const idf = Math.log(totalDocs / (docsWithTerm + 1));
      this.idfCache.set(term, idf);
    }
  }

  private computeTF(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    const totalTokens = tokens.length;

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Normalize by document length
    for (const [token, count] of tf.entries()) {
      tf.set(token, count / totalTokens);
    }

    return tf;
  }

  public scoreDocument(filePath: string, query: string): number {
    const doc = this.documents.find((d) => d.path === filePath);
    if (!doc) return 0;

    const queryTokens = this.tokenize(query);
    const docTF = this.computeTF(doc.tokens);

    let score = 0;
    for (const queryToken of queryTokens) {
      const tf = docTF.get(queryToken) || 0;
      const idf = this.idfCache.get(queryToken) || 0;
      score += tf * idf;
    }

    return score;
  }

  public getTopTerms(filePath: string, limit: number = 10): string[] {
    const doc = this.documents.find((d) => d.path === filePath);
    if (!doc) return [];

    const docTF = this.computeTF(doc.tokens);
    const scores = Array.from(docTF.entries())
      .map(([term, tf]) => ({
        term,
        score: tf * (this.idfCache.get(term) || 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scores.map((s) => s.term);
  }
}

// Embedding provider abstraction
class EmbeddingProvider {
  private provider: any = null;
  private model: string = "";

  constructor(settings: UserSettings) {
    this.initializeProvider(settings);
  }

  private initializeProvider(settings: UserSettings): void {
    // Try OpenAI first
    const openaiKey =
      settings.providerSettings?.openai?.apiKey?.value ||
      getEnvVar("OPENAI_API_KEY");
    if (openaiKey) {
      this.provider = createOpenAI({ apiKey: openaiKey });
      this.model = "text-embedding-3-small";
      logger.info("Using OpenAI embeddings (text-embedding-3-small)");
      return;
    }

    // Try Google/Vertex
    const googleKey =
      settings.providerSettings?.google?.apiKey?.value ||
      getEnvVar("GOOGLE_API_KEY");
    if (googleKey) {
      this.provider = createGoogleGenerativeAI({ apiKey: googleKey });
      this.model = "text-embedding-004";
      logger.info("Using Google embeddings (text-embedding-004)");
      return;
    }

    // Try Vertex (check if vertex settings exist and have required fields)
    const vertexSettings = settings.providerSettings?.vertex as any;
    if (vertexSettings && vertexSettings.projectId && vertexSettings.location) {
      this.provider = createVertex({
        project: vertexSettings.projectId,
        location: vertexSettings.location,
        googleAuthOptions: vertexSettings.serviceAccountKey?.value
          ? { credentials: JSON.parse(vertexSettings.serviceAccountKey.value) }
          : undefined,
      });
      this.model = "text-embedding-004";
      logger.info("Using Vertex embeddings (text-embedding-004)");
      return;
    }

    logger.info("No embedding provider configured, will use TF-IDF fallback");
    logger.debug(
      "Available providers: OpenAI, Google, Vertex - configure API keys to enable embeddings",
    );
  }

  public async isAvailable(): Promise<boolean> {
    return this.provider !== null;
  }

  public async embed(text: string): Promise<number[]> {
    if (!this.provider) {
      throw new Error("No embedding provider available");
    }

    try {
      const { embedding } = await embed({
        model: this.provider.textEmbeddingModel(this.model),
        value: text,
      });
      return embedding;
    } catch (error) {
      logger.error("Embedding failed:", error);
      throw error;
    }
  }
}

// Embedding cache management
class EmbeddingCache {
  private cacheDir: string;

  constructor() {
    this.cacheDir = CACHE_DIR;
    this.ensureCacheDir();
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      logger.warn("Failed to create embeddings cache directory:", error);
    }
  }

  private getCacheKey(filePath: string, content: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(filePath);
    hash.update(content);
    return hash.digest("hex");
  }

  private getCachePath(cacheKey: string): string {
    return path.join(this.cacheDir, `${cacheKey}.json`);
  }

  public async get(
    filePath: string,
    content: string,
    mtime: number,
  ): Promise<number[] | null> {
    try {
      const cacheKey = this.getCacheKey(filePath, content);
      const cachePath = this.getCachePath(cacheKey);

      const cacheData = await fs.readFile(cachePath, "utf-8");
      const cached: EmbeddingCacheData = JSON.parse(cacheData);

      // Check if cache is still valid (mtime matches)
      if (cached.mtime === mtime) {
        return cached.embedding;
      }

      // Cache is stale, remove it
      await fs.unlink(cachePath).catch(() => {});
      return null;
    } catch {
      // Cache miss or error
      return null;
    }
  }

  public async set(
    filePath: string,
    content: string,
    mtime: number,
    embedding: number[],
  ): Promise<void> {
    try {
      const cacheKey = this.getCacheKey(filePath, content);
      const cachePath = this.getCachePath(cacheKey);
      const hash = this.getCacheKey(filePath, content);

      const cacheData: EmbeddingCacheData = {
        embedding,
        hash,
        mtime,
      };

      await fs.writeFile(cachePath, JSON.stringify(cacheData));
    } catch (error) {
      logger.warn("Failed to cache embedding:", error);
    }
  }

  public async cleanup(
    maxAge: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<void> {
    try {
      const files = await fs.readdir(this.cacheDir);
      const now = Date.now();

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filePath = path.join(this.cacheDir, file);
        const stats = await fs.stat(filePath);

        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
        }
      }
    } catch (error) {
      logger.warn("Failed to cleanup embedding cache:", error);
    }
  }
}

// Heuristic scoring
class HeuristicScorer {
  public static scoreByPath(
    filePath: string,
    query: string,
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();
    const queryLower = query.toLowerCase();

    // Extract keywords from query
    const queryKeywords = queryLower
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2);

    // File name contains query keywords
    for (const keyword of queryKeywords) {
      if (fileName.includes(keyword)) {
        score += 0.8;
        reasons.push(`filename contains "${keyword}"`);
      }
      if (dirName.includes(keyword)) {
        score += 0.4;
        reasons.push(`directory contains "${keyword}"`);
      }
    }

    // File type relevance
    const ext = path.extname(filePath).toLowerCase();
    if ([".tsx", ".jsx"].includes(ext) && queryLower.includes("component")) {
      score += 0.6;
      reasons.push("React component file");
    }
    if ([".ts", ".js"].includes(ext) && queryLower.includes("function")) {
      score += 0.4;
      reasons.push("JavaScript/TypeScript file");
    }
    if (ext === ".css" && queryLower.includes("style")) {
      score += 0.6;
      reasons.push("CSS file");
    }

    // Configuration files
    if (["package.json", "tsconfig.json", ".env"].includes(fileName)) {
      if (queryLower.includes("config") || queryLower.includes("setup")) {
        score += 0.7;
        reasons.push("configuration file");
      }
    }

    // Test files (usually lower priority unless specifically mentioned)
    if (fileName.includes("test") || fileName.includes("spec")) {
      if (queryLower.includes("test")) {
        score += 0.5;
        reasons.push("test file");
      } else {
        score -= 0.3;
        reasons.push("test file (deprioritized)");
      }
    }

    return { score, reasons };
  }

  public static scoreByRecency(mtime: number): {
    score: number;
    reasons: string[];
  } {
    const now = Date.now();
    const ageMs = now - mtime;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    let score = 0;
    const reasons: string[] = [];

    if (ageDays < 1) {
      score = 0.5;
      reasons.push("modified today");
    } else if (ageDays < 7) {
      score = 0.3;
      reasons.push("modified this week");
    } else if (ageDays < 30) {
      score = 0.1;
      reasons.push("modified this month");
    }

    return { score, reasons };
  }
}

// Cosine similarity utility
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

// Main Smart Context Engine
export class SmartContextEngine {
  private embeddingProvider: EmbeddingProvider;
  private embeddingCache: EmbeddingCache;

  constructor(settings: UserSettings) {
    this.embeddingProvider = new EmbeddingProvider(settings);
    this.embeddingCache = new EmbeddingCache();

    // Cleanup old cache entries on startup
    this.embeddingCache.cleanup().catch(() => {});
  }

  public async selectFiles(
    options: SmartContextOptions,
  ): Promise<SmartContextResult> {
    const startTime = Date.now();
    logger.info(
      `Starting Smart Context selection in ${options.mode} mode for ${options.appPath}`,
    );
    logger.debug(
      `Prompt context: ${options.promptContext.userPrompt.slice(0, 100)}...`,
    );
    logger.debug(
      `Recent messages count: ${options.promptContext.recentMessages.length}`,
    );

    // If mode is off, use traditional behavior
    if (options.mode === "off") {
      return this.selectFilesTraditional(options);
    }

    // Extract all candidate files
    const { files: candidateFiles } = await extractCodebase({
      appPath: options.appPath,
      chatContext: options.chatContext,
    });

    logger.info(`Found ${candidateFiles.length} candidate files`);
    logger.debug(
      `Candidate files: ${candidateFiles
        .slice(0, 5)
        .map((f) => f.path)
        .join(", ")}${candidateFiles.length > 5 ? "..." : ""}`,
    );

    // Calculate token budget
    const tokenBudget =
      options.tokenBudget ||
      (await this.calculateTokenBudget(options.model, options.settings));
    logger.info(`Token budget: ${tokenBudget} tokens`);
    logger.debug(`Model: ${options.model.provider}/${options.model.name}`);

    // Convert to candidates with metadata
    const candidates = await this.prepareCandidates(candidateFiles, options);

    // Score candidates
    const scoredCandidates = await this.scoreCandidates(candidates, options);

    // Select files within budget
    const selectedFiles = this.selectWithinBudget(
      scoredCandidates,
      tokenBudget,
      options,
    );

    const endTime = Date.now();
    logger.info(
      `Smart Context selection completed in ${endTime - startTime}ms`,
    );
    logger.info(
      `Selection summary: ${selectedFiles.length}/${candidates.length} files, ${selectedFiles.reduce((sum, f) => sum + f.tokens, 0)}/${tokenBudget} tokens`,
    );
    logger.debug(
      `Selected files: ${selectedFiles
        .slice(0, 10)
        .map((f) => f.path)
        .join(", ")}${selectedFiles.length > 10 ? "..." : ""}`,
    );

    return {
      selectedFiles: selectedFiles.map((c) => ({
        path: c.path,
        content: c.content,
        force: c.isAutoInclude,
      })),
      debug: {
        totalCandidates: candidates.length,
        selectedCount: selectedFiles.length,
        tokenUsage: selectedFiles.reduce((sum, f) => sum + f.tokens, 0),
        tokenBudget,
        scoringMethod: (await this.embeddingProvider.isAvailable())
          ? "embeddings"
          : "tf-idf",
        topScores: selectedFiles.slice(0, 10).map((f) => ({
          path: f.path,
          score: f.score,
          reason: f.reasons.join(", "),
        })),
        autoIncludesCount: selectedFiles.filter((f) => f.isAutoInclude).length,
        excludedCount: candidates.length - selectedFiles.length,
      },
    };
  }

  private async selectFilesTraditional(
    options: SmartContextOptions,
  ): Promise<SmartContextResult> {
    // Traditional behavior - use extractCodebase as-is
    const { files } = await extractCodebase({
      appPath: options.appPath,
      chatContext: options.chatContext,
    });

    const totalTokens = files.reduce(
      (sum, f) => sum + estimateTokens(f.content),
      0,
    );

    return {
      selectedFiles: files,
      debug: {
        totalCandidates: files.length,
        selectedCount: files.length,
        tokenUsage: totalTokens,
        tokenBudget: totalTokens,
        scoringMethod: "traditional",
        topScores: [],
        autoIncludesCount: files.filter((f) => f.force).length,
        excludedCount: 0,
      },
    };
  }

  private async calculateTokenBudget(
    model: LargeLanguageModel,
    _settings: UserSettings,
  ): Promise<number> {
    const maxTokens = await getMaxTokens(model);

    // Reserve tokens for:
    // - System prompt (~2000 tokens)
    // - User messages (~1000 tokens)
    // - Model output (~4000 tokens)
    // - Safety buffer (~1000 tokens)
    const reservedTokens = 8000;

    return Math.max((maxTokens || 32000) - reservedTokens, 10000); // Minimum 10k tokens for context
  }

  private async prepareCandidates(
    files: CodebaseFile[],
    options: SmartContextOptions,
  ): Promise<FileCandidate[]> {
    const candidates: FileCandidate[] = [];
    const autoIncludePaths = new Set(
      options.chatContext.smartContextAutoIncludes?.map((p) => p.globPath) ||
        [],
    );

    for (const file of files) {
      const tokens = estimateTokens(file.content);
      const isAutoInclude =
        autoIncludePaths.has(file.path) || file.force || false;

      candidates.push({
        ...file,
        score: 0,
        reasons: [],
        isAutoInclude,
        tokens,
      });
    }

    return candidates;
  }

  private async scoreCandidates(
    candidates: FileCandidate[],
    options: SmartContextOptions,
  ): Promise<FileCandidate[]> {
    const query = this.buildQuery(options.promptContext);
    const keywords = this.extractKeywords(query);

    // Try embedding-based scoring first
    let scored: FileCandidate[];
    if (await this.embeddingProvider.isAvailable()) {
      scored = await this.scoreWithEmbeddings(candidates, query, options);
    } else {
      scored = this.scoreWithTFIDF(candidates, query, options);
    }

    // Apply keyword-based hard/soft filters post-scoring to drop obvious noise
    for (const c of scored) {
      const baseName = path.basename(c.path).toLowerCase();
      const dir = path.dirname(c.path).toLowerCase();
      const text = (c.content || "").toLowerCase();

      const hasKeywordInPath = keywords.some(
        (k) => baseName.includes(k) || dir.includes(k),
      );
      const hasKeywordInContent = keywords.some((k) => text.includes(k));

      // Domain-specific positive boosts
      const wantsWatermark = keywords.some((k) =>
        ["watermark", "ternary", "made"].includes(k),
      );
      if (wantsWatermark) {
        if (
          baseName.includes("made-with-ternary") ||
          baseName.includes("watermark") ||
          text.includes("made with ternary")
        ) {
          c.score += 2.0;
          c.reasons.push("bonus: watermark-related file");
        }
      }
      const wantsThemeToggle = keywords.some((k) =>
        ["theme", "toggle", "dark", "light"].includes(k),
      );
      if (wantsThemeToggle) {
        const themePaths = [
          "theme",
          "toggle",
          "globals.css",
          "tailwind.config",
          "index.html",
          "app.css",
          "layout",
          "ThemeToggle",
          "toggle-group",
        ];
        if (
          themePaths.some(
            (p) =>
              baseName.includes(p.toLowerCase()) ||
              dir.includes(p.toLowerCase()),
          )
        ) {
          c.score += 1.5;
          c.reasons.push("bonus: theme-toggle related path");
        }
      }

      // Negative categories unless explicitly mentioned
      const negativeDirs = [
        "chart",
        "charts",
        "graph",
        "analytics",
        "test",
        "stories",
        "storybook",
      ]; // broad UI libs
      const isNegativeDir = negativeDirs.some(
        (d) => dir.includes(d) || baseName.includes(d),
      );
      const mentionedNegative = keywords.some((k) => negativeDirs.includes(k));

      // If it's a typical noise bucket and no keyword matches anywhere, penalize heavily
      if (
        isNegativeDir &&
        !mentionedNegative &&
        !hasKeywordInPath &&
        !hasKeywordInContent
      ) {
        c.score -= 5;
        c.reasons.push("penalty: negative-dir without mention");
      }

      // Require at least some keyword match OR a strong score later
      if (!hasKeywordInPath && !hasKeywordInContent) {
        c.score -= 0.5; // small nudge down for lack of any hint
        c.reasons.push("penalty: no keyword hint");
      } else {
        c.score += 0.5; // reward tangible hint
        c.reasons.push("bonus: keyword match");
      }
    }

    // Re-sort after adjustments
    scored.sort((a: FileCandidate, b: FileCandidate) => b.score - a.score);
    return scored;
  }

  private buildQuery(
    promptContext: SmartContextOptions["promptContext"],
  ): string {
    let query = promptContext.userPrompt;

    // Add recent user messages for context
    const recentUserMessages = promptContext.recentMessages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join(" ");

    if (recentUserMessages) {
      query += " " + recentUserMessages;
    }

    return query;
  }

  // Extract meaningful keywords from a text to use for hard and soft matching
  private extractKeywords(text: string): string[] {
    const raw = text
      .toLowerCase()
      .replace(/[\W_]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && t.length <= 40);
    const stop = new Set([
      "the",
      "and",
      "you",
      "your",
      "with",
      "that",
      "this",
      "from",
      "into",
      "for",
      "not",
      "but",
      "are",
      "was",
      "were",
      "have",
      "has",
      "had",
      "will",
      "would",
      "could",
      "should",
      "about",
      "page",
      "component",
      "file",
      "files",
      "please",
      "make",
      "add",
      "remove",
      "change",
      "update",
      "toggle",
      "dark",
      "light",
      "mode",
      "new",
      "old",
      "like",
      "just",
      "need",
      "want",
      "can",
      "able",
    ]);
    const out: string[] = [];
    for (const t of raw) {
      if (!stop.has(t) && !out.includes(t)) out.push(t);
    }
    return out.slice(0, 15);
  }

  private async scoreWithEmbeddings(
    candidates: FileCandidate[],
    query: string,
    options: SmartContextOptions,
  ): Promise<FileCandidate[]> {
    logger.info(`Scoring ${candidates.length} candidates with embeddings`);
    logger.debug(`Query length: ${query.length} chars`);

    try {
      // Get query embedding
      const queryEmbedding = await this.embeddingProvider.embed(query);

      // Score each candidate
      for (const candidate of candidates) {
        let embedding: number[] | null = null;

        // Try to get from cache first
        try {
          const stats = await fs.stat(
            path.join(options.appPath, candidate.path),
          );
          embedding = await this.embeddingCache.get(
            candidate.path,
            candidate.content,
            stats.mtimeMs,
          );
        } catch {
          // File might not exist or other error, continue without cache
        }

        // Generate embedding if not cached
        if (!embedding) {
          try {
            embedding = await this.embeddingProvider.embed(candidate.content);

            // Cache the embedding
            try {
              const stats = await fs.stat(
                path.join(options.appPath, candidate.path),
              );
              await this.embeddingCache.set(
                candidate.path,
                candidate.content,
                stats.mtimeMs,
                embedding,
              );
            } catch {
              // Caching failed, but we can continue
            }
          } catch (error) {
            logger.warn(
              `Failed to generate embedding for ${candidate.path}:`,
              error,
            );
            continue;
          }
        }

        // Calculate similarity score
        const similarity = cosineSimilarity(queryEmbedding, embedding);
        candidate.score = similarity;
        candidate.reasons.push(
          `embedding similarity: ${similarity.toFixed(3)}`,
        );

        // Add heuristic boosts
        this.addHeuristicScores(candidate, query, options);
      }
    } catch (error) {
      logger.error("Embedding scoring failed, falling back to TF-IDF:", error);
      return this.scoreWithTFIDF(candidates, query, options);
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  private scoreWithTFIDF(
    candidates: FileCandidate[],
    query: string,
    options: SmartContextOptions,
  ): FileCandidate[] {
    logger.info(`Scoring ${candidates.length} candidates with TF-IDF`);
    logger.debug(`Query: ${query.slice(0, 100)}...`);

    const scorer = new TFIDFScorer(candidates);

    for (const candidate of candidates) {
      const tfidfScore = scorer.scoreDocument(candidate.path, query);
      candidate.score = tfidfScore;
      candidate.reasons.push(`tf-idf score: ${tfidfScore.toFixed(3)}`);

      // Add heuristic boosts
      this.addHeuristicScores(candidate, query, options);
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  private addHeuristicScores(
    candidate: FileCandidate,
    query: string,
    options: SmartContextOptions,
  ): void {
    // Path-based scoring
    const pathScore = HeuristicScorer.scoreByPath(candidate.path, query);
    candidate.score += pathScore.score;
    candidate.reasons.push(...pathScore.reasons);

    // Recency scoring
    try {
      const stats = require("fs").statSync(
        path.join(options.appPath, candidate.path),
      );
      const recencyScore = HeuristicScorer.scoreByRecency(stats.mtimeMs);
      candidate.score += recencyScore.score;
      candidate.reasons.push(...recencyScore.reasons);
    } catch {
      // File might not exist, skip recency scoring
    }

    // Auto-include boost
    if (candidate.isAutoInclude) {
      candidate.score += 10; // High boost to ensure auto-includes are selected
      candidate.reasons.push("auto-include");
    }
  }

  private selectWithinBudget(
    candidates: FileCandidate[],
    tokenBudget: number,
    options: SmartContextOptions,
  ): FileCandidate[] {
    const selected: FileCandidate[] = [];
    let usedTokens = 0;

    // Always include auto-includes first
    const autoIncludes = candidates.filter((c) => c.isAutoInclude);
    for (const autoInclude of autoIncludes) {
      selected.push(autoInclude);
      usedTokens += autoInclude.tokens;
    }

    // Select remaining files based on score and mode
    const remaining = candidates.filter((c) => !c.isAutoInclude);

    // Dynamic thresholds: conservative is stricter
    const maxFiles = options.mode === "conservative" ? 8 : 20;

    // Determine a score threshold relative to distribution
    const scores = remaining.map((r) => r.score).sort((a, b) => a - b);
    const pct = options.mode === "conservative" ? 0.85 : 0.7; // keep top X percentile
    const idx = Math.max(
      0,
      Math.min(scores.length - 1, Math.floor(scores.length * pct)),
    );
    const percentileCut = scores[idx] ?? 0;
    const minScore = Math.max(percentileCut, 0.15); // also require a small absolute score

    for (const candidate of remaining) {
      if (candidate.score < minScore) {
        candidate.reasons.push(
          `filtered: below threshold ${minScore.toFixed(2)}`,
        );
        continue;
      }
      if (selected.length >= maxFiles) break;
      if (usedTokens + candidate.tokens > tokenBudget) break;
      selected.push(candidate);
      usedTokens += candidate.tokens;
    }

    logger.info(
      `Selected ${selected.length} files using ${usedTokens}/${tokenBudget} tokens (${((usedTokens / tokenBudget) * 100).toFixed(1)}% of budget)`,
    );
    logger.debug(
      `Auto-includes: ${selected.filter((f) => f.isAutoInclude).length}, Regular: ${selected.filter((f) => !f.isAutoInclude).length}`,
    );
    logger.debug(
      `Average score: ${(selected.reduce((sum, f) => sum + f.score, 0) / selected.length).toFixed(3)}`,
    );

    return selected;
  }
}

// Factory function for easy usage
export async function selectSmartContext(
  options: SmartContextOptions,
): Promise<SmartContextResult> {
  const engine = new SmartContextEngine(options.settings);
  return engine.selectFiles(options);
}
