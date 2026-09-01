#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const runId = process.argv[2];
if (runId === undefined || !/^[A-Za-z0-9._-]+$/.test(runId)) {
  console.error(`Usage: ${process.argv[1]} <run-id>`);
  process.exit(2);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const runDirectory = resolve(repositoryRoot, ".audit/verification/runs", runId);
const databasePath = (await readFile(resolve(runDirectory, "database-path"), "utf8")).trim();
const evidencePath = (await readFile(resolve(runDirectory, "evidence-path"), "utf8")).trim();

if (!databasePath.startsWith(`${runDirectory}/`)) {
  throw new Error("Database path is outside the run directory");
}
if (evidencePath !== resolve(repositoryRoot, ".audit/verification/evidence", runId)) {
  throw new Error("Evidence path is outside the expected directory");
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const conversation = database.prepare(`
    SELECT id, created_at AS createdAt
    FROM conversations
    ORDER BY rowid DESC
    LIMIT 1
  `).get();
  if (conversation === undefined) {
    throw new Error("No conversation exists in the verification database");
  }

  const messages = database.prepare(`
    SELECT id, role, content, created_at AS createdAt, position
    FROM messages
    WHERE conversation_id = ?
    ORDER BY position ASC
  `).all(conversation.id);
  const pendingReply = database.prepare(`
    SELECT source_message_id AS sourceMessageId
    FROM pending_replies
    WHERE conversation_id = ?
  `).get(conversation.id) ?? null;
  const promotionGrants = database.prepare(`
    SELECT pacific_date AS pacificDate, code, created_at AS createdAt
    FROM promotion_grants
    WHERE conversation_id = ?
    ORDER BY pacific_date ASC
  `).all(conversation.id);

  const artifact = {
    capturedAt: new Date().toISOString(),
    runId,
    conversation,
    messages,
    pendingReply,
    promotionGrants,
  };
  const outputPath = resolve(evidencePath, "persisted-transcript.json");
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(outputPath);
} finally {
  database.close();
}
