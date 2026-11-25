import { expect, test } from "bun:test";
import {
	type BskyEnv,
	bskyPass,
	fitPost,
	linkFacets,
	picturesOf,
	questionOf,
} from "../src/bluesky";

function fakeDb(init: Record<string, string> = {}) {
	const state = new Map(Object.entries(init));
	const db = {
		prepare(sql: string) {
			return {
				bind: (...a: unknown[]) => ({
					first: async () =>
						sql.startsWith("SELECT")
							? state.has(String(a[0]))
								? { v: state.get(String(a[0])) }
								: null
							: null,
					all: async () => ({ results: [] }),
					run: async () => {
						if (sql.startsWith("INSERT")) state.set(String(a[0]), String(a[1]));
						return { meta: {} };
					},
				}),
			};
		},
	};
	return { db: db as unknown as BskyEnv["DB"], state };
}
const base = (db: BskyEnv["DB"], extra: Partial<BskyEnv> = {}): BskyEnv => ({
	DB: db,
	BSKY_HANDLE: "askflisk.bsky.social",
	BSKY_APP_PASSWORD: "app-pass-word-xxxx",
	CHAT_ANSWER_KEY: "c".repeat(30),
	BSKY_REPLY_LIVE: "1",
	...extra,
});

const minutesAgo = (m: number) =>
	new Date(Date.now() - m * 60_000).toISOString();
const note = (
	n: number,
	text: string,
	extra: Record<string, unknown> = {},
	handle = "ann.bsky.social",
) => ({
	uri: `at://did:plc:${handle}/app.bsky.feed.post/${n}`,
	cid: `cid${n}`,
	reason: "mention",
	indexedAt: minutesAgo(10 - n),
	author: { did: `did:plc:${handle}`, handle },
	record: { text, ...extra },
});

// A scripted Bluesky + chat.
function world(
	notifications: object[],
	chat = {
		status: 200,
		body: { text: "London: rain, 9°C." } as Record<string, unknown>,
	},
	views: object[] = [],
	opts: { expireFirst?: boolean; refreshFails?: boolean } = {},
) {
	const records: any[] = [];
	const asked: any[] = [];
	const calls: string[] = [];
	const blobs: { type: string; size: number }[] = [];
	let expired = !!opts.expireFirst;
	const f = (async (url: string, init: RequestInit = {}) => {
		const u = String(url);
		const auth = String(
			(init.headers as Record<string, string>)?.authorization || "",
		);
		calls.push(
			`${init.method || "GET"} ${u.replace(/^https:\/\/bsky\.social\/xrpc\//, "")} ${auth ? "auth" : ""}`,
		);
		if (u.endsWith("createSession"))
			return Response.json({
				did: "did:plc:bot",
				accessJwt: "acc2",
				refreshJwt: "ref2",
			});
		if (u.endsWith("refreshSession"))
			return opts.refreshFails
				? Response.json({}, { status: 400 })
				: Response.json({
						did: "did:plc:bot",
						accessJwt: "acc3",
						refreshJwt: "ref3",
					});
		if (u.includes("listNotifications")) {
			if (expired && auth.includes("old")) {
				expired = false;
				return Response.json({ error: "ExpiredToken" }, { status: 400 });
			}
			return Response.json({ notifications });
		}
		if (u.includes("getPosts")) return Response.json({ posts: views });
		if (u.endsWith("uploadBlob")) {
			blobs.push({
				type: String((init.headers as any)["content-type"]),
				size: (init.body as Uint8Array).length,
			});
			return Response.json({
				blob: {
					$type: "blob",
					ref: { $link: "bafy" },
					mimeType: "image/png",
					size: 4,
				},
			});
		}
		if (u.endsWith("createRecord")) {
			records.push(JSON.parse(String(init.body)));
			return Response.json({ uri: "at://x", cid: "c" });
		}
		if (u.endsWith("/api/answer")) {
			asked.push(JSON.parse(String(init.body)));
			return Response.json(chat.body, { status: chat.status });
		}
		return new Response("?", { status: 404 });
	}) as unknown as typeof fetch;
	return { f, records, asked, calls, blobs };
}
const session = JSON.stringify({
	did: "did:plc:bot",
	accessJwt: "acc",
	refreshJwt: "ref",
});

test("questionOf drops the bot's handle", () => {
	expect(
		questionOf(
			"@askflisk.bsky.social weather in london ",
			"askflisk.bsky.social",
		),
	).toBe("weather in london");
	expect(questionOf("hey @askflisk what is bun?", "askflisk.bsky.social")).toBe(
		"hey what is bun?",
	);
});

test("fitPost keeps a link whole and fits 300 graphemes", () => {
	const link = "https://chat.flisk.si/app/abc";
	const t = fitPost("x".repeat(500), link);
	expect([...new Intl.Segmenter().segment(t)].length).toBeLessThanOrEqual(300);
	expect(t.endsWith(` ${link}`)).toBe(true);
	expect(fitPost("short")).toBe("short");
});

test("linkFacets uses UTF-8 byte offsets", () => {
	const text = "é👍 see https://a.b/c.";
	const [f] = linkFacets(text);
	const bytes = new TextEncoder().encode(text);
	expect(
		new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd)),
	).toBe("https://a.b/c");
	expect(f.features[0].uri).toBe("https://a.b/c");
});

test("picturesOf reads photos, a video preview and a quoted post's photo", () => {
	const cdn = (s: string) => `https://cdn.bsky.app/img/feed_thumbnail/${s}`;
	expect(picturesOf({ images: [{ thumb: cdn("a") }] })).toEqual([cdn("a")]);
	expect(
		picturesOf({
			$type: "video",
			thumbnail: "https://video.bsky.app/x/thumbnail.jpg",
		}),
	).toEqual([]);
	expect(picturesOf({ thumbnail: cdn("v") })).toEqual([cdn("v")]);
	expect(
		picturesOf({ record: { embeds: [{ images: [{ thumb: cdn("q") }] }] } }),
	).toEqual([cdn("q")]);
	expect(
		picturesOf({
			media: { images: [{ thumb: cdn("m") }] },
			record: { record: { embeds: [{ images: [{ thumb: cdn("r") }] }] } },
		}),
	).toEqual([cdn("m"), cdn("r")]);
	expect(
		picturesOf({ images: [{ thumb: "https://evil.example/a.jpg" }] }),
	).toEqual([]);
});

test("not configured: does nothing", async () => {
	const { db } = fakeDb();
	const w = world([]);
	const r = await bskyPass({ DB: db }, w.f);
	expect(r.stopped).toBe("not configured");
	expect(w.calls).toEqual([]);
});

test("logs in, answers a mention as a reply with root and parent, and moves the cursor", async () => {
	const { db, state } = fakeDb();
	const n = note(5, "@askflisk.bsky.social weather in london");
	const w = world([n]);
	const r = await bskyPass(base(db), w.f);
	expect(r.answered).toBe(1);
	expect(w.asked[0].question).toBe("weather in london");
	expect(w.asked[0].asker).toBe("bsky:did:plc:ann.bsky.social");
	const rec = w.records[0];
	expect(rec.repo).toBe("did:plc:bot");
	expect(rec.record.text).toBe("London: rain, 9°C.");
	expect(rec.record.reply).toEqual({
		root: { uri: n.uri, cid: n.cid },
		parent: { uri: n.uri, cid: n.cid },
	});
	expect(state.get("bsky_since")).toBe(n.indexedAt);
	expect(JSON.parse(state.get("bsky_session") || "{}").accessJwt).toBe("acc2");
	expect(JSON.stringify([...state])).not.toContain("app-pass-word");
});

test("a reply in a thread keeps the thread root", async () => {
	const { db } = fakeDb({ bsky_session: session });
	const root = { uri: "at://r/app.bsky.feed.post/1", cid: "rc" };
	const parent = { uri: "at://p/app.bsky.feed.post/2", cid: "pc" };
	const n = note(5, "@askflisk.bsky.social is neon good?", {
		reply: { root, parent },
	});
	const w = world([n]);
	await bskyPass(base(db), w.f);
	expect(w.records[0].record.reply).toEqual({
		root,
		parent: { uri: n.uri, cid: n.cid },
	});
});

test("dry run posts nothing but moves on", async () => {
	const { db, state } = fakeDb({ bsky_session: session });
	const logs: string[] = [];
	const n = note(5, "@askflisk.bsky.social hi");
	const w = world([n]);
	const r = await bskyPass(base(db, { BSKY_REPLY_LIVE: "0" }), w.f, (s) =>
		logs.push(s),
	);
	expect(r.dry).toBe(1);
	expect(w.records).toEqual([]);
	expect(logs[0]).toContain("bluesky dry run");
	expect(state.get("bsky_since")).toBe(n.indexedAt);
});

test("ignores its own posts, ignored accounts and old notifications", async () => {
	const { db } = fakeDb({ bsky_session: session, bsky_since: minutesAgo(4) });
	const w = world([
		note(8, "@askflisk.bsky.social hi", {}, "askflisk.bsky.social"),
		note(7, "@askflisk.bsky.social hi", {}, "spam.bsky.social"),
		note(1, "@askflisk.bsky.social too old"),
	]);
	const r = await bskyPass(base(db, { BSKY_IGNORE: "spam.bsky.social" }), w.f);
	expect(r.answered).toBe(0);
	expect(r.skipped).toBe(2);
	expect(w.asked).toEqual([]);
});

test("first run only looks at the last minutes, not the backlog", async () => {
	const { db } = fakeDb({ bsky_session: session });
	const old = {
		...note(1, "@askflisk.bsky.social old"),
		indexedAt: minutesAgo(600),
	};
	const w = world([note(5, "@askflisk.bsky.social new"), old]);
	await bskyPass(base(db), w.f);
	expect(w.asked.map((a) => a.question)).toEqual(["new"]);
});

test("answers oldest first and at most the per-pass cap", async () => {
	const { db, state } = fakeDb({ bsky_session: session });
	const a = note(3, "@askflisk.bsky.social one", {}, "a.bsky.social");
	const b = note(4, "@askflisk.bsky.social two", {}, "b.bsky.social");
	const c = note(5, "@askflisk.bsky.social three", {}, "c.bsky.social");
	const w = world([c, b, a]);
	const r = await bskyPass(base(db, { BSKY_REPLIES_PER_PASS: "2" }), w.f);
	expect(w.asked.map((x) => x.question)).toEqual(["one", "two"]);
	expect(r.answered).toBe(2);
	expect(state.get("bsky_since")).toBe(b.indexedAt);
});

test("stops at the hourly cap and keeps the mention for later", async () => {
	const hour = String(Math.floor(Date.now() / 3600_000));
	const { db, state } = fakeDb({
		bsky_session: session,
		bsky_hour: `${hour}:8`,
	});
	const w = world([note(5, "@askflisk.bsky.social hi")]);
	const r = await bskyPass(base(db), w.f);
	expect(r.stopped).toBe("reply cap reached for now");
	expect(w.asked).toEqual([]);
	expect(state.has("bsky_since")).toBe(false);
});

test("counts what it sent", async () => {
	const { db, state } = fakeDb({ bsky_session: session });
	const w = world([note(5, "@askflisk.bsky.social hi")]);
	await bskyPass(base(db), w.f);
	expect(state.get("bsky_hour")?.endsWith(":1")).toBe(true);
	expect(state.get("bsky_day")?.endsWith(":1")).toBe(true);
});

test("an admin can pause and resume", async () => {
	const { db, state } = fakeDb({ bsky_session: session });
	const env = base(db, { BSKY_ADMIN: "boss.bsky.social" });
	const w1 = world([
		note(5, "@askflisk.bsky.social pause", {}, "boss.bsky.social"),
	]);
	expect((await bskyPass(env, w1.f)).stopped).toBe("paused");
	expect(state.get("bsky_paused")).toBe("1");
	const w2 = world([note(6, "@askflisk.bsky.social hi")]);
	await bskyPass(env, w2.f);
	expect(w2.asked).toEqual([]);
	const w3 = world([
		note(7, "@askflisk.bsky.social resume", {}, "boss.bsky.social"),
	]);
	await bskyPass(env, w3.f);
	expect(state.get("bsky_paused")).toBe("0");
});

test("a stranger cannot pause", async () => {
	const { db, state } = fakeDb({ bsky_session: session });
	const w = world([note(5, "@askflisk.bsky.social pause")]);
	await bskyPass(base(db), w.f);
	expect(state.get("bsky_paused")).toBeUndefined();
	expect(w.asked.length).toBe(1);
});

test("sends the pictures of the post replied to and the post it quotes, and its text", async () => {
	const { db } = fakeDb({ bsky_session: session });
	const parentRef = { uri: "at://p/app.bsky.feed.post/2", cid: "pc" };
	const n = note(5, "@askflisk.bsky.social is this ranking right?", {
		reply: { root: parentRef, parent: parentRef },
	});
	const cdn = (s: string) =>
		`https://cdn.bsky.app/img/feed_thumbnail/plain/did/${s}@jpeg`;
	const w = world([n], undefined, [
		{
			uri: parentRef.uri,
			record: { text: "top 10 frameworks" },
			embed: {
				record: {
					value: { text: "quoted words" },
					embeds: [{ images: [{ thumb: cdn("q") }] }],
				},
				images: [{ thumb: cdn("p") }],
			},
		},
		{
			uri: n.uri,
			record: { text: "x" },
			embed: { images: [{ thumb: cdn("m") }, { thumb: cdn("m2") }] },
		},
	]);
	await bskyPass(base(db), w.f);
	expect(w.asked[0].images).toEqual([cdn("p"), cdn("q")]);
	expect(w.asked[0].context).toBe("top 10 frameworks quoted words");
});

test("uploads a drawn picture and attaches it, with a link facet", async () => {
	const { db } = fakeDb({ bsky_session: session });
	const png = `data:image/png;base64,${btoa("abcd")}`;
	const w = world([note(5, "@askflisk.bsky.social draw a cat")], {
		status: 200,
		body: { text: "Here.", image: png, link: "https://chat.flisk.si/app/xyz" },
	});
	await bskyPass(base(db), w.f);
	expect(w.blobs).toEqual([{ type: "image/png", size: 4 }]);
	const rec = w.records[0].record;
	expect(rec.text).toBe("Here. https://chat.flisk.si/app/xyz");
	expect(rec.embed.images[0].image.$type).toBe("blob");
	expect(rec.facets[0].features[0].uri).toBe("https://chat.flisk.si/app/xyz");
});

test("refreshes an expired token, and logs in again when the refresh fails", async () => {
	const old = JSON.stringify({
		did: "did:plc:bot",
		accessJwt: "old",
		refreshJwt: "ref",
	});
	const a = fakeDb({ bsky_session: old });
	const w1 = world([note(5, "@askflisk.bsky.social hi")], undefined, [], {
		expireFirst: true,
	});
	expect((await bskyPass(base(a.db), w1.f)).answered).toBe(1);
	expect(w1.calls.some((c) => c.includes("refreshSession"))).toBe(true);
	expect(JSON.parse(a.state.get("bsky_session") || "{}").accessJwt).toBe(
		"acc3",
	);

	const b = fakeDb({ bsky_session: old });
	const w2 = world([note(5, "@askflisk.bsky.social hi")], undefined, [], {
		expireFirst: true,
		refreshFails: true,
	});
	expect((await bskyPass(base(b.db), w2.f)).answered).toBe(1);
	expect(w2.calls.some((c) => c.includes("createSession"))).toBe(true);
});

test("chat busy: stops and keeps the mention; asker cap: skips it", async () => {
	const a = fakeDb({ bsky_session: session });
	const w1 = world([note(5, "@askflisk.bsky.social hi")], {
		status: 503,
		body: {},
	});
	expect((await bskyPass(base(a.db), w1.f)).stopped).toBe("chat answered 503");
	expect(a.state.has("bsky_since")).toBe(false);

	const b = fakeDb({ bsky_session: session });
	const w2 = world([note(5, "@askflisk.bsky.social hi")], {
		status: 429,
		body: { kind: "asker" },
	});
	const r = await bskyPass(base(b.db), w2.f);
	expect(r.skipped).toBe(1);
	expect(b.state.has("bsky_since")).toBe(true);
});
