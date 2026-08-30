/**
 * Vitest coverage for deskComputerManagement.ts (#33 Stage B — the desk
 * computer's pure management helpers). Same discipline as
 * wallComputerMap.test.ts: no DOM, no globals, no Y.Doc, no fetch — every
 * assertion runs against a plain function call.
 *
 * These tests pin the rules the desk computer's management pane MUST
 * enforce so the pane never quietly drifts from the network panel's or the
 * phone roster's already-shipped behaviour (main.ts §5192 rename maxLength,
 * §5476 access-mode LWW read, §2530 CLONES SEEN ordering).
 */

import { describe, expect, it } from "vitest";

import {
  ACCESS_MODES,
  ROOM_NAME_MAX_LENGTH,
  describeAccessMode,
  isValidInviteLink,
  normalizeAccessMode,
  orderedRoster,
  ownershipLabel,
  sanitizeRoomName,
  type AccessMode,
  type RawRosterRow,
  type RosterEntry,
} from "./deskComputerManagement";

// ── sanitizeRoomName ─────────────────────────────────────────────────────────

describe("sanitizeRoomName", () => {
  it("returns null for non-string values", () => {
    expect(sanitizeRoomName(undefined)).toBeNull();
    expect(sanitizeRoomName(null)).toBeNull();
    expect(sanitizeRoomName(42)).toBeNull();
    expect(sanitizeRoomName({ toString: () => "hostile" })).toBeNull();
  });

  it("returns null for empty / whitespace-only strings", () => {
    expect(sanitizeRoomName("")).toBeNull();
    expect(sanitizeRoomName("   ")).toBeNull();
    expect(sanitizeRoomName("\n\t  ")).toBeNull();
  });

  it("trims surrounding whitespace but keeps interior spacing", () => {
    expect(sanitizeRoomName("  Lobby  ")).toBe("Lobby");
    expect(sanitizeRoomName("  A  B  ")).toBe("A  B");
  });

  it("passes strings within the length cap unchanged", () => {
    const exactly = "x".repeat(ROOM_NAME_MAX_LENGTH);
    expect(sanitizeRoomName(exactly)).toBe(exactly);
    expect(sanitizeRoomName("Furlong Lobby")).toBe("Furlong Lobby");
  });

  it("hard-truncates overflow to the network panel's cap (matches main.ts §5192)", () => {
    // Truncation guard: a paste-in longer than the network panel's input
    // maxLength (24) must not persist as-is. The desk pane and the network
    // panel share ROOM_NAME_MAX_LENGTH so a name accepted here would also
    // be accepted there.
    expect(ROOM_NAME_MAX_LENGTH).toBe(24);
    const overlong = "x".repeat(ROOM_NAME_MAX_LENGTH + 8);
    const trimmed = sanitizeRoomName(overlong);
    expect(trimmed).not.toBeNull();
    expect(trimmed!.length).toBe(ROOM_NAME_MAX_LENGTH);
  });
});

// ── normalizeAccessMode ──────────────────────────────────────────────────────

describe("normalizeAccessMode", () => {
  it("preserves the three canonical modes", () => {
    expect(normalizeAccessMode("public")).toBe("public");
    expect(normalizeAccessMode("pass")).toBe("pass");
    expect(normalizeAccessMode("keyed")).toBe("keyed");
  });

  it("defaults every unknown / hostile value to 'pass' (matches main.ts §5476 LWW)", () => {
    // Same LWW behaviour getRoomAccessMode ships with: anything not 'public'
    // or 'keyed' collapses to the default 'pass'. A hostile / older peer
    // therefore cannot jam the pane by writing a novel string.
    expect(normalizeAccessMode(undefined)).toBe("pass");
    expect(normalizeAccessMode(null)).toBe("pass");
    expect(normalizeAccessMode("")).toBe("pass");
    expect(normalizeAccessMode(42)).toBe("pass");
    expect(normalizeAccessMode({})).toBe("pass");
    expect(normalizeAccessMode("hostile-value")).toBe("pass");
  });

  it("is case-sensitive on purpose", () => {
    // A peer writing 'PUBLIC' (wrong case) is a bug, not a permission —
    // the pane must not promote it silently.
    expect(normalizeAccessMode("PUBLIC")).toBe("pass");
    expect(normalizeAccessMode("Keyed")).toBe("pass");
  });
});

describe("ACCESS_MODES", () => {
  it("lists every AccessMode in a stable order", () => {
    // The DOM selector relies on this order (public / pass / keyed) so the
    // ordering is part of the contract, not an incidental value.
    expect(ACCESS_MODES).toEqual(["public", "pass", "keyed"]);
  });

  it("stays in sync with the AccessMode literal-union type", () => {
    // Compile-time: if a mode is added to the union the switch in
    // describeAccessMode fails to compile, but ACCESS_MODES may be
    // forgotten. This assertion catches that drift at test time by
    // walking each listed mode through describeAccessMode.
    for (const mode of ACCESS_MODES) {
      expect(describeAccessMode(mode as AccessMode)).toMatch(/·/);
    }
  });
});

// ── describeAccessMode ───────────────────────────────────────────────────────

describe("describeAccessMode", () => {
  it("returns the same wording main.ts §5470 ACCESS_MODE_COPY uses", () => {
    // Word-for-word match: the ACCESS app and the desk pane must not
    // describe the same mode differently. If main.ts changes its copy, this
    // test should be updated in the SAME PR — a diverged copy is a bug.
    expect(describeAccessMode("public")).toBe(
      "PUBLIC · anyone can enter this room.",
    );
    expect(describeAccessMode("pass")).toBe(
      "PASS · anyone with the link can enter (default).",
    );
    expect(describeAccessMode("keyed")).toBe(
      "KEYED · granted keys only (enforced once keyed identity ships).",
    );
  });
});

// ── orderedRoster ────────────────────────────────────────────────────────────

describe("orderedRoster", () => {
  const validEntry = (name: string, joinedAt: number, keyed = false) => ({
    name,
    joinedAt,
    outfitId: "default",
    ...(keyed ? { keyB64: "k".repeat(43), keySig: "s".repeat(86) } : {}),
  });

  it("returns [] for an empty input", () => {
    expect(orderedRoster([], "me", "owner")).toEqual([]);
  });

  it("labels the local player with isMe: true", () => {
    const rows: RawRosterRow[] = [
      { id: "me", entry: validEntry("Alice", 100) },
    ];
    const out = orderedRoster(rows, "me", "owner");
    expect(out).toHaveLength(1);
    expect(out[0].isMe).toBe(true);
    expect(out[0].isOwner).toBe(false);
  });

  it("labels a matching owner with isOwner: true", () => {
    const rows: RawRosterRow[] = [
      { id: "owner-a", entry: validEntry("Alice", 100) },
      { id: "peer-b", entry: validEntry("Bob", 200) },
    ];
    const out = orderedRoster(rows, "peer-b", "owner-a");
    expect(out[0]).toMatchObject({ id: "owner-a", isOwner: true, isMe: false });
    expect(out[1]).toMatchObject({ id: "peer-b", isOwner: false, isMe: true });
  });

  it("sorts rows by joinedAt ascending (matches main.ts §2530)", () => {
    const rows: RawRosterRow[] = [
      { id: "late", entry: validEntry("Late", 300) },
      { id: "early", entry: validEntry("Early", 100) },
      { id: "mid", entry: validEntry("Mid", 200) },
    ];
    const out = orderedRoster(rows, "none", "none");
    expect(out.map((r) => r.id)).toEqual(["early", "mid", "late"]);
  });

  it("treats a missing / non-numeric joinedAt as 0 so it sorts first", () => {
    const rows: RawRosterRow[] = [
      { id: "late", entry: validEntry("Late", 200) },
      // joinedAt omitted deliberately — hostile / older client shape
      { id: "unknown", entry: { name: "Unknown", outfitId: "default" } },
      { id: "hostile", entry: validEntry("HostileNumber", Number.NaN) },
    ];
    const out = orderedRoster(rows, "none", "none");
    expect(out[0].id).not.toBe("late");
    expect(out[2].id).toBe("late");
    // The two 0-sorted rows preserve input order (Array.sort is stable per
    // ES2019 spec — a tie by joinedAt must not shuffle).
    expect(out.slice(0, 2).map((r) => r.id)).toEqual(["unknown", "hostile"]);
  });

  it("flags entries carrying a name↔key self-cert as hasKeyCert: true", () => {
    const rows: RawRosterRow[] = [
      { id: "keyed-peer", entry: validEntry("Verified", 100, true) },
      { id: "keyless-peer", entry: validEntry("NoCert", 200) },
      // Partial cert (key without sig) does NOT count — mirrors the phone's
      // ★ FRIEND affordance which requires BOTH fields (main.ts §2559).
      { id: "half-cert", entry: {
        name: "Half",
        joinedAt: 300,
        outfitId: "default",
        keyB64: "k".repeat(43),
        keySig: "",
      } },
    ];
    const out = orderedRoster(rows, "none", "none");
    expect(out.find((r) => r.id === "keyed-peer")?.hasKeyCert).toBe(true);
    expect(out.find((r) => r.id === "keyless-peer")?.hasKeyCert).toBe(false);
    expect(out.find((r) => r.id === "half-cert")?.hasKeyCert).toBe(false);
  });

  it("preserves malformed entries but marks them malformed: true", () => {
    // A hostile write (non-object entry) must not disappear the peer's
    // presence — the pane needs to see them as "someone was here" even if
    // the row payload is junk.
    const rows: RawRosterRow[] = [
      { id: "junk", entry: "not-an-object" },
      { id: "good", entry: validEntry("Alice", 100) },
    ];
    const out = orderedRoster(rows, "none", "none");
    const junk = out.find((r) => r.id === "junk");
    expect(junk).toBeDefined();
    expect(junk!.malformed).toBe(true);
    expect(junk!.name).toBe("Unknown-Clone");
    expect(junk!.hasKeyCert).toBe(false);
    const good = out.find((r) => r.id === "good");
    expect(good!.malformed).toBe(false);
  });

  it("falls back to 'Unknown-Clone' when the name is missing / empty", () => {
    const rows: RawRosterRow[] = [
      { id: "empty-name", entry: { joinedAt: 100, outfitId: "default", name: "" } },
      { id: "nameless", entry: { joinedAt: 200, outfitId: "default" } },
    ];
    const out = orderedRoster(rows, "none", "none");
    expect(out.every((r) => r.name === "Unknown-Clone")).toBe(true);
  });

  it("drops rows with an empty / non-string id", () => {
    // The id column is the Y.Map key — an empty / non-string id cannot be
    // used to route friend / kick actions, so the pane must never see it.
    const rows: RawRosterRow[] = [
      { id: "", entry: { name: "A", joinedAt: 1, outfitId: "default" } },
      { id: null as unknown as string, entry: { name: "B", joinedAt: 2, outfitId: "default" } },
      { id: "keep", entry: { name: "C", joinedAt: 3, outfitId: "default" } },
    ];
    const out = orderedRoster(rows, "none", "none");
    expect(out.map((r) => r.id)).toEqual(["keep"]);
  });

  it("defaults outfitId to 'default' when missing / not a string", () => {
    const rows: RawRosterRow[] = [
      { id: "a", entry: { name: "A", joinedAt: 1 } },
      { id: "b", entry: { name: "B", joinedAt: 2, outfitId: "" } },
      { id: "c", entry: { name: "C", joinedAt: 3, outfitId: 42 } },
      { id: "d", entry: { name: "D", joinedAt: 4, outfitId: "custom" } },
    ];
    const out = orderedRoster(rows, "none", "none");
    const byId = new Map<string, RosterEntry>(out.map((r) => [r.id, r]));
    expect(byId.get("a")!.outfitId).toBe("default");
    expect(byId.get("b")!.outfitId).toBe("default");
    expect(byId.get("c")!.outfitId).toBe("default");
    expect(byId.get("d")!.outfitId).toBe("custom");
  });
});

// ── isValidInviteLink ────────────────────────────────────────────────────────

describe("isValidInviteLink", () => {
  it("accepts an ssf://room?seed=… carrier (non-shareable-origin mint)", () => {
    expect(isValidInviteLink("ssf://room?seed=abc123")).toBe(true);
    // A minted seed is a URL-encoded compact carrier — treat any non-empty
    // seed value as valid, without decoding the payload here (that is the
    // bootstrap importer's job — parity with main.ts §4967).
    expect(
      isValidInviteLink("ssf://room?seed=%7B%22roomId%22%3A%22r1%22%7D"),
    ).toBe(true);
  });

  it("accepts an http(s):// carrier with a seed query", () => {
    expect(isValidInviteLink("http://example.com/?seed=abc")).toBe(true);
    expect(
      isValidInviteLink("https://ssf.example.com/game.html?seed=payload"),
    ).toBe(true);
    // Other query params alongside seed are fine.
    expect(
      isValidInviteLink("https://example.com/?utm=x&seed=abc&ref=y"),
    ).toBe(true);
  });

  it("rejects empty / non-string / hostile-scheme values", () => {
    expect(isValidInviteLink("")).toBe(false);
    expect(isValidInviteLink(undefined)).toBe(false);
    expect(isValidInviteLink(null)).toBe(false);
    expect(isValidInviteLink(42)).toBe(false);
    // The pane's COPY affordance must never propagate an executable scheme
    // even if the input box got hijacked.
    expect(isValidInviteLink("javascript:alert(1)")).toBe(false);
    expect(isValidInviteLink("data:text/plain,seed=abc")).toBe(false);
    expect(isValidInviteLink("file:///etc/passwd?seed=abc")).toBe(false);
  });

  it("rejects a carrier missing the seed query param", () => {
    expect(isValidInviteLink("ssf://room")).toBe(false);
    expect(isValidInviteLink("ssf://room?")).toBe(false);
    expect(isValidInviteLink("ssf://room?other=1")).toBe(false);
    expect(isValidInviteLink("http://example.com/")).toBe(false);
    expect(isValidInviteLink("http://example.com/?seed=")).toBe(false);
  });

  it("rejects wrong ssf paths (only the room bootstrap carrier is valid)", () => {
    // The mint format is exactly `ssf://room?seed=…`; any other scheme
    // route is inert and must not be paste-ready.
    expect(isValidInviteLink("ssf://not-room?seed=abc")).toBe(false);
    expect(isValidInviteLink("ssf://room/extra?seed=abc")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isValidInviteLink("http://[bad")).toBe(false);
    expect(isValidInviteLink("not a url")).toBe(false);
  });
});

// ── ownershipLabel ───────────────────────────────────────────────────────────

describe("ownershipLabel", () => {
  it("appends ' (you)' when the viewer holds owner authority", () => {
    expect(ownershipLabel("Alice", true)).toBe("Alice (you)");
  });

  it("returns the plain name when the viewer is NOT the owner", () => {
    expect(ownershipLabel("Alice", false)).toBe("Alice");
  });

  it("falls back to 'Unknown-Clone' when the resolved name is empty", () => {
    // The resolver upstream (main.ts §2468) shortens a bare UUID, but a
    // buggy caller may still pass an empty string — the pane must render
    // SOMETHING, not a bare " (you)".
    expect(ownershipLabel("", false)).toBe("Unknown-Clone");
    expect(ownershipLabel("", true)).toBe("Unknown-Clone (you)");
  });
});
