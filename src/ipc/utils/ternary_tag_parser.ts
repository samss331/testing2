import { normalizePath } from "../../../shared/normalizePath";
import log from "electron-log";
import { SqlQuery } from "../../lib/schemas";

const logger = log.scope("ternary_tag_parser");

export function getTernaryWriteTags(fullResponse: string): {
  path: string;
  content: string;
  description?: string;
}[] {
  const ternaryWriteRegex =
    /<ternary-write([^>]*)>([\s\S]*?)<\/ternary-write>/gi;
  const pathRegex = /path="([^"]+)"/;
  const descriptionRegex = /description="([^"]+)"/;

  let match;
  const tags: { path: string; content: string; description?: string }[] = [];

  while ((match = ternaryWriteRegex.exec(fullResponse)) !== null) {
    const attributesString = match[1];
    let content = match[2].trim();

    const pathMatch = pathRegex.exec(attributesString);
    const descriptionMatch = descriptionRegex.exec(attributesString);

    if (pathMatch && pathMatch[1]) {
      const path = pathMatch[1];
      const description = descriptionMatch?.[1];

      const contentLines = content.split("\n");
      if (contentLines[0]?.startsWith("```")) {
        contentLines.shift();
      }
      if (contentLines[contentLines.length - 1]?.startsWith("```")) {
        contentLines.pop();
      }
      content = contentLines.join("\n");

      tags.push({ path: normalizePath(path), content, description });
    } else {
      logger.warn(
        "Found <ternary-write> tag without a valid 'path' attribute:",
        match[0],
      );
    }
  }
  return tags;
}

export function getTernaryRenameTags(fullResponse: string): {
  from: string;
  to: string;
}[] {
  const ternaryRenameRegex =
    /<ternary-rename from="([^"]+)" to="([^"]+)"[^>]*>([\s\S]*?)<\/ternary-rename>/g;
  let match;
  const tags: { from: string; to: string }[] = [];
  while ((match = ternaryRenameRegex.exec(fullResponse)) !== null) {
    tags.push({
      from: normalizePath(match[1]),
      to: normalizePath(match[2]),
    });
  }
  return tags;
}

export function getTernaryDeleteTags(fullResponse: string): string[] {
  const ternaryDeleteRegex =
    /<ternary-delete path="([^"]+)"[^>]*>([\s\S]*?)<\/ternary-delete>/g;
  let match;
  const paths: string[] = [];
  while ((match = ternaryDeleteRegex.exec(fullResponse)) !== null) {
    paths.push(normalizePath(match[1]));
  }
  return paths;
}

export function getTernaryAddDependencyTags(fullResponse: string): string[] {
  const ternaryAddDependencyRegex =
    /<ternary-add-dependency packages="([^"]+)">[^<]*<\/ternary-add-dependency>/g;
  let match;
  const packages: string[] = [];
  while ((match = ternaryAddDependencyRegex.exec(fullResponse)) !== null) {
    packages.push(...match[1].split(" "));
  }
  return packages;
}

export function getTernaryChatSummaryTag(fullResponse: string): string | null {
  const ternaryChatSummaryRegex =
    /<ternary-chat-summary>([\s\S]*?)<\/ternary-chat-summary>/g;
  const match = ternaryChatSummaryRegex.exec(fullResponse);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

export function getTernaryExecuteSqlTags(fullResponse: string): SqlQuery[] {
  const ternaryExecuteSqlRegex =
    /<ternary-execute-sql([^>]*)>([\s\S]*?)<\/ternary-execute-sql>/g;
  const descriptionRegex = /description="([^"]+)"/;
  let match;
  const queries: { content: string; description?: string }[] = [];

  while ((match = ternaryExecuteSqlRegex.exec(fullResponse)) !== null) {
    const attributesString = match[1] || "";
    let content = match[2].trim();
    const descriptionMatch = descriptionRegex.exec(attributesString);
    const description = descriptionMatch?.[1];

    // Handle markdown code blocks if present
    const contentLines = content.split("\n");
    if (contentLines[0]?.startsWith("```")) {
      contentLines.shift();
    }
    if (contentLines[contentLines.length - 1]?.startsWith("```")) {
      contentLines.pop();
    }
    content = contentLines.join("\n");

    queries.push({ content, description });
  }

  return queries;
}

export function getTernaryCommandTags(fullResponse: string): string[] {
  const ternaryCommandRegex =
    /<ternary-command type="([^"]+)"[^>]*><\/ternary-command>/g;
  let match;
  const commands: string[] = [];

  while ((match = ternaryCommandRegex.exec(fullResponse)) !== null) {
    commands.push(match[1]);
  }

  return commands;
}
