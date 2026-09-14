import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  deleteSessionEntryLifecycle,
  listSessionEntriesCore,
  listSessionParticipantsReadOnly,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadSessionEntry,
  MAX_SESSION_PARTICIPANTS,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";

const parseSessionEntryCalls = vi.hoisted(() => vi.fn());
vi.mock("./session-accessor.sqlite-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-status.js")>();
  return {
    ...actual,
    parseSessionEntryJson: (...args: Parameters<typeof actual.parseSessionEntryJson>) => {
      if (args[0].current_session_id === undefined) {
        parseSessionEntryCalls();
      }
      return actual.parseSessionEntryJson(...args);
    },
  };
});

const profile = (id: string): SessionParticipantIdentity => ({ type: "profile", id });
const remote = (id: string, domain = "workspace"): SessionParticipantIdentity => ({
  type: "remote",
  pluginId: "test-channel",
  domain,
  idKind: "user",
  id,
});

afterEach(() => closeOpenClawAgentDatabasesForTest());

async function participantCacheFixture(env: NodeJS.ProcessEnv) {
  const scope = { agentId: "main", env, sessionKey: "agent:main:participant-cache" };
  await upsertSessionEntryCore(scope, { sessionId: "participant-cache", updatedAt: 1 });
  await upsertSessionEntryCore(
    { ...scope, sessionKey: "agent:main:sibling" },
    { sessionId: "sibling", updatedAt: 1 },
  );
  recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 10 });
  recordSessionParticipant(scope, { identity: profile("b"), promptedAt: 20 });
  return {
    scope,
    database: openOpenClawAgentDatabase(scope),
    read: () => listSessionEntriesCore({ ...scope, clone: false, projection: "list" }),
  };
}

describe("SQLite session participants", () => {
  it.each([
    {
      name: "later",
      id: "a",
      first: 10,
      at: 30,
      last: 30,
      count: 2,
      stable: true,
      order: ["a", "b"],
    },
    {
      name: "equal",
      id: "a",
      first: 10,
      at: 10,
      last: 10,
      count: 2,
      stable: true,
      order: ["a", "b"],
    },
    {
      name: "unknown first",
      id: "a",
      first: null,
      at: 30,
      last: 30,
      count: 2,
      stable: true,
      order: ["a", "b"],
    },
    {
      name: "insert",
      id: "c",
      first: 15,
      at: 15,
      last: 15,
      count: 1,
      stable: false,
      order: ["a", "c", "b"],
    },
    {
      name: "backdate",
      id: "b",
      first: 5,
      at: 5,
      last: 20,
      count: 2,
      stable: false,
      order: ["b", "a"],
    },
    {
      name: "caller invalidation",
      id: "a",
      first: 10,
      at: 30,
      last: 30,
      count: 2,
      stable: false,
      order: ["b", "a"],
    },
  ])("preserves participant cache coherence for $name input", async (input) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { scope, database, read } = await participantCacheFixture(state.env);
      if (input.first === null) {
        runOpenClawAgentWriteTransaction((db) => {
          db.db
            .prepare(
              "UPDATE session_participants SET first_prompted_at = NULL WHERE session_key = ? AND actor_id = ?",
            )
            .run(scope.sessionKey, input.id);
          publishSessionEntryCacheInvalidation(db);
        }, scope);
      }
      const before = read();
      expect(before).toHaveLength(2);
      if (input.name === "caller invalidation") {
        runOpenClawAgentWriteTransaction((db) => {
          db.db
            .prepare(
              "UPDATE session_participants SET first_prompted_at = 5 WHERE session_key = ? AND actor_id = 'b'",
            )
            .run(scope.sessionKey);
          publishSessionEntryCacheInvalidation(db);
        }, scope);
      }
      const events: Array<{ event: SessionLifecycleEvent; inTransaction: boolean }> = [];
      const stop = onSessionLifecycleEvent((event) => {
        if (event.sessionKey === scope.sessionKey && event.reason === "participants") {
          events.push({ event, inTransaction: database.db.isTransaction });
        }
      });
      try {
        parseSessionEntryCalls.mockClear();
        expect(
          recordSessionParticipant(scope, { identity: profile(input.id), promptedAt: input.at }),
        ).toBe(input.name === "insert" ? "inserted" : "updated");
        const after = read();
        expect(after).toHaveLength(before.length);
        expect(
          after.find((row) => row.sessionKey === scope.sessionKey)?.entry.participants,
        ).toEqual(input.order.map((id) => ({ identity: profile(id) })));
        if (input.stable) {
          expect(parseSessionEntryCalls).not.toHaveBeenCalled();
          after.forEach((row, index) => expect(row.entry).toBe(before[index]?.entry));
        }
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toContainEqual({
          identity: profile(input.id),
          contributionCount: input.count,
          firstPromptedAt: input.first,
          lastPromptedAt: input.last,
        });
        expect(events).toEqual([
          {
            event: expect.objectContaining({
              agentId: "main",
              sessionKey: scope.sessionKey,
              reason: "participants",
            }),
            inTransaction: false,
          },
        ]);
      } finally {
        stop();
      }
    });
  });

  it("keeps participant cache and lifecycle publication behind the outer commit", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { scope, database, read } = await participantCacheFixture(state.env);
      const before = read();
      const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey);
      const events: Array<{ event: SessionLifecycleEvent; inTransaction: boolean }> = [];
      const stop = onSessionLifecycleEvent((event) => {
        if (event.sessionKey === scope.sessionKey && event.reason === "participants") {
          events.push({ event, inTransaction: database.db.isTransaction });
        }
      });
      const write = () => {
        recordSessionParticipant(scope, { identity: profile("a"), promptedAt: 30 });
        recordSessionParticipant(scope, { identity: profile("c"), promptedAt: 15 });
        expect(events).toHaveLength(0);
      };
      try {
        expect(() =>
          runOpenClawAgentWriteTransaction(() => {
            write();
            throw new Error("participant rollback");
          }, scope),
        ).toThrow("participant rollback");
        parseSessionEntryCalls.mockClear();
        const rolledBack = read();
        expect(rolledBack).toEqual(before);
        rolledBack.forEach((row, index) => expect(row.entry).toBe(before[index]?.entry));
        expect(parseSessionEntryCalls).not.toHaveBeenCalled();
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual(records);
        expect(events).toHaveLength(0);
        runOpenClawAgentWriteTransaction(write, scope);
        expect(events).toHaveLength(2);
        expect(events.every((event) => !event.inTransaction)).toBe(true);
        expect(
          read().find((row) => row.sessionKey === scope.sessionKey)?.entry.participantCount,
        ).toBe(3);
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toContainEqual({
          identity: profile("a"),
          contributionCount: 2,
          firstPromptedAt: 10,
          lastPromptedAt: 30,
        });
      } finally {
        stop();
      }
    });
  });

  it("isolates an invalid participant identity to its requested session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env };
      const keys = ["agent:main:before", "agent:main:invalid", "agent:main:after"] as const;
      for (const [index, sessionKey] of keys.entries()) {
        await upsertSessionEntryCore(
          { ...scope, sessionKey },
          { sessionId: `session-${index}`, updatedAt: index + 1 },
        );
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: profile(`person-${index}`), promptedAt: index + 1 },
        );
      }
      const read = (sessionKeys: readonly string[], projection: "full" | "list") =>
        loadExactSessionEntryCandidatesReadOnlyBatch(
          sessionKeys.map((sessionKey) => ({ ...scope, sessionKeys: [sessionKey], projection })),
        );
      expect(read(keys, "list").every((result) => result.ok)).toBe(true);
      const database = openOpenClawAgentDatabase(scope);
      // Model a damaged saved namespace without changing the session row or schema.
      database.db
        .prepare("UPDATE session_participants SET identity_namespace = ? WHERE session_key = ?")
        .run('{"type":"profile","extra":true}', keys[1]);
      const expectedEntry = (index: 0 | 1 | 2) => ({
        ok: true,
        value: [
          {
            sessionKey: keys[index],
            entry: {
              participants: [{ identity: profile(`person-${index}`) }],
              participantCount: 1,
            },
          },
        ],
      });
      for (const projection of ["full", "list"] as const) {
        expect(read([keys[0], keys[1], "agent:main:missing", keys[2]], projection)).toMatchObject([
          expectedEntry(0),
          {
            ok: false,
            error: expect.objectContaining({
              message: "Session participant identity is invalid; run openclaw doctor --fix.",
            }),
          },
          { ok: true, value: [] },
          expectedEntry(2),
        ]);
        expect(read([keys[0], keys[2]], projection)).toMatchObject([
          expectedEntry(0),
          expectedEntry(2),
        ]);
      }
    });
  });

  it("does not create a missing agent database during participant reads", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      expect(listSessionParticipantsReadOnly({ agentId: "absent", env: state.env }).size).toBe(0);
      expect(existsSync(state.agentDir("absent"))).toBe(false);
    });
  });

  it.each([false, true])(
    "keeps namespaces and times separate (profile first: %s)",
    async (profileFirst) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:collision" };
        await upsertSessionEntryCore(scope, { sessionId: "collision", updatedAt: 1 });
        const inputs = [
          { identity: remote("same-id"), promptedAt: 10 },
          { identity: remote("same-id"), promptedAt: 20 },
          { identity: profile("same-id"), promptedAt: 30 },
          { identity: profile("same-id"), promptedAt: 40 },
          { identity: remote("same-id"), promptedAt: 50 },
          { identity: remote("same-id"), promptedAt: 5 },
        ];
        for (const input of profileFirst ? inputs.toReversed() : inputs) {
          recordSessionParticipant(scope, input);
        }
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "same-id" },
          promptedAt: 40,
        });
        recordSessionParticipant(scope, {
          identity: remote("same-id", "other-workspace"),
          promptedAt: 40,
        });
        closeOpenClawAgentDatabasesForTest();
        const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? [];
        expect(records).toHaveLength(4);
        expect(records).toEqual(
          expect.arrayContaining([
            {
              identity: profile("same-id"),
              contributionCount: 2,
              firstPromptedAt: 30,
              lastPromptedAt: 40,
            },
            {
              identity: remote("same-id"),
              contributionCount: 4,
              firstPromptedAt: 5,
              lastPromptedAt: 50,
            },
            {
              identity: remote("same-id", "other-workspace"),
              contributionCount: 1,
              firstPromptedAt: 40,
              lastPromptedAt: 40,
            },
            {
              identity: { type: "agent", id: "same-id" },
              contributionCount: 1,
              firstPromptedAt: 40,
              lastPromptedAt: 40,
            },
          ]),
        );
      });
    },
  );

  it.each([false, true])(
    "updates a merged profile at the admission bound (canonical row: %s)",
    async (hasCanonicalRow) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:merged-full" };
        const old = ensureProfileForEmail("old@example.test", { env: state.env });
        const current = ensureProfileForEmail("current@example.test", { env: state.env });
        await upsertSessionEntryCore(scope, { sessionId: "merged-full", updatedAt: 1 });
        recordSessionParticipant(scope, { identity: profile(old.id), promptedAt: 10 });
        if (hasCanonicalRow) {
          recordSessionParticipant(scope, { identity: profile(current.id), promptedAt: 20 });
        }
        for (let index = hasCanonicalRow ? 2 : 1; index < MAX_SESSION_PARTICIPANTS; index++) {
          recordSessionParticipant(scope, { identity: remote(`remote-${index}`), promptedAt: 30 });
        }
        linkEmail("old@example.test", current.id, { env: state.env });
        const listScope = { ...scope, clone: false, projection: "list" as const };
        const cached = listSessionEntriesCore(listScope)[0]?.entry;
        expect(cached?.participantCount).toBe(MAX_SESSION_PARTICIPANTS);
        parseSessionEntryCalls.mockClear();
        expect(
          recordSessionParticipant(scope, { identity: profile(current.id), promptedAt: 40 }),
        ).toBe("updated");
        const listed = listSessionEntriesCore(listScope)[0]?.entry;
        if (hasCanonicalRow) {
          expect(listed).toBe(cached);
          expect(parseSessionEntryCalls).not.toHaveBeenCalled();
        } else {
          expect(listed).not.toBe(cached);
          expect(parseSessionEntryCalls).toHaveBeenCalled();
        }
        const records = listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? [];
        expect(records).toHaveLength(MAX_SESSION_PARTICIPANTS);
        const profiles = records.filter((record) => record.identity.type === "profile");
        expect(profiles.reduce((count, record) => count + record.contributionCount, 0)).toBe(
          hasCanonicalRow ? 3 : 2,
        );
        expect(
          profiles.find((record) => record.identity.id === (hasCanonicalRow ? current.id : old.id)),
        ).toMatchObject({ contributionCount: 2, lastPromptedAt: 40 });
      });
    },
  );

  it("keeps the admission bound, unknown first time, reset history, and deletion ownership", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:bounded" };
      await upsertSessionEntryCore(scope, { sessionId: "bounded", updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "bounded" });
      database.db.exec("DROP TABLE session_participants");
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "bounded" });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_participants'")
          .get(),
      ).toBeUndefined();
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
        expect(
          recordSessionParticipant(scope, {
            identity: profile(`profile-${index}`),
            promptedAt: 10,
          }),
        ).toBe("inserted");
      }
      expect(
        recordSessionParticipant(scope, { identity: remote("profile-0"), promptedAt: 10 }),
      ).toBe("capped");
      expect(
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "main" },
          sessionAgentId: "main",
        }),
      ).toBeNull();
      database.db
        .prepare(
          "UPDATE session_participants SET first_prompted_at = NULL, last_prompted_at = NULL WHERE actor_id = 'profile-0'",
        )
        .run();
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 20 });
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 20 });
      recordSessionParticipant(scope, { identity: profile("profile-0"), promptedAt: 15 });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toContainEqual({
        identity: profile("profile-0"),
        contributionCount: 4,
        firstPromptedAt: null,
        lastPromptedAt: 20,
      });
      await upsertSessionEntryCore(scope, { sessionId: "bounded-reset", updatedAt: 30 });
      expect(loadSessionEntry(scope)?.participants).toHaveLength(MAX_SESSION_PARTICIPANTS);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: database.path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: false,
      });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toBeUndefined();
    });
  });

  it("preserves over-bound repair histories and does not inflate retried cross-store copies", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sourceScope = { agentId: "source", env: state.env, sessionKey: "agent:source:shared" };
      const targetScope = { agentId: "main", env: state.env, sessionKey: "agent:main:shared" };
      await upsertSessionEntryCore(sourceScope, { sessionId: "source", updatedAt: 1 });
      await upsertSessionEntryCore(targetScope, { sessionId: "target", updatedAt: 1 });
      for (let index = 0; index < MAX_SESSION_PARTICIPANTS; index++) {
        recordSessionParticipant(sourceScope, {
          identity: profile(`profile-${index}`),
          promptedAt: 10,
        });
        recordSessionParticipant(targetScope, {
          identity: remote(`profile-${index}`),
          promptedAt: 20,
        });
      }
      recordSessionParticipant(sourceScope, { identity: profile("profile-0"), promptedAt: 30 });
      const source = openOpenClawAgentDatabase({ agentId: "source", env: state.env });
      const target = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      copySessionNodeArtifactsForRepair(
        source,
        target,
        [sourceScope.sessionKey],
        targetScope.sessionKey,
      );
      copySessionNodeArtifactsForRepair(
        source,
        target,
        [sourceScope.sessionKey],
        targetScope.sessionKey,
      );
      const rows = listSessionParticipantsReadOnly(targetScope).get(targetScope.sessionKey) ?? [];
      expect(rows).toHaveLength(64);
      expect(
        rows.find((row) => row.identity.type === "profile" && row.identity.id === "profile-0")
          ?.contributionCount,
      ).toBe(2);
      expect(
        recordSessionParticipant(targetScope, { identity: profile("overflow"), promptedAt: 40 }),
      ).toBe("capped");
    });
  });
});
