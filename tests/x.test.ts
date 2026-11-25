import { expect, test } from "bun:test";
import { oauthHeader, questionOf, type XEnv, xPass } from "../src/x";

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
	return { db: db as unknown as XEnv["DB"], state };
}
const base = (db: XEnv["DB"], extra: Partial<XEnv> = {}): XEnv => ({
	DB: db,
	X_API_KEY: "k",
	X_API_SECRET: "s",
	X_ACCESS_TOKEN: "t",
	X_ACCESS_SECRET: "ts",
	CHAT_ANSWER_KEY: "c".repeat(30),
	...extra,
});

// A scripted X + chat: mentions come back oldest-last (X returns newest first), posts are recorded.
function world(
	mentions: object[],
	users: object[],
	chat = { status: 200, body: { text: "London: rain, 9°C." } },
	tweets: object[] = [],
	media: object[] = [],
	lookup: object | null = null,
) {
	const posts: any[] = [];
	const asked: any[] = [];
	const uploads: FormData[] = [];
	const f = (async (url: string, init: RequestInit = {}) => {
		const u = String(url);
		if (u.includes("/users/me")) return Response.json({ data: { id: "99" } });
		if (/\/tweets\/\d+/.test(u) && lookup) return Response.json(lookup);
		if (u.includes("/mentions"))
			return Response.json({
				data: mentions,
				includes: { users, tweets, media },
			});
		if (u.endsWith("/media/upload")) {
			uploads.push(init.body as FormData);
			return Response.json({ data: { id: "m1" } });
		}
		if (u.endsWith("/tweets")) {
			posts.push(JSON.parse(String(init.body)));
			return Response.json({ data: { id: "1" } }, { status: 201 });
		}
		if (u.endsWith("/api/answer")) {
			asked.push(JSON.parse(String(init.body)));
			return Response.json(chat.body, { status: chat.status });
		}
		return new Response("?", { status: 404 });
	}) as unknown as typeof fetch;
	return { f, posts, asked, uploads };
}

test("questionOf drops the reply chain and the handle", () => {
	expect(questionOf("@askflisk weather in london ", "askflisk")).toBe(
		"weather in london",
	);
	expect(
		questionOf("@bob @askflisk what is bun? https://t.co/abc", "askflisk"),
	).toBe("what is bun?");
	expect(questionOf("@askflisk", "askflisk")).toBe("");
});

test("oauth header matches the signature example from the X docs shape (stable, sorted, percent-encoded)", async () => {
	const a = await oauthHeader(
		"GET",
		"https://api.x.com/2/users/me",
		{},
		base(fakeDb().db),
		"nonce",
		"1700000000",
	);
	expect(a).toStartWith(
		'OAuth oauth_consumer_key="k", oauth_nonce="nonce", oauth_signature="',
	);
	expect(a).toContain('oauth_signature_method="HMAC-SHA1"');
	expect(a).toBe(
		await oauthHeader(
			"GET",
			"https://api.x.com/2/users/me",
			{},
			base(fakeDb().db),
			"nonce",
			"1700000000",
		),
	);
});

test("a dry run asks chat, posts nothing, and moves on", async () => {
	const { db, state } = fakeDb();
	const w = world(
		[{ id: "12", text: "@askflisk weather in london", author_id: "5" }],
		[{ id: "5", username: "bob" }],
	);
	const logs: string[] = [];
	const r = await xPass(base(db), w.f, (s) => logs.push(s));
	expect(r).toMatchObject({ seen: 1, dry: 1, answered: 0 });
	expect(w.posts).toEqual([]);
	expect(w.asked[0]).toEqual({ question: "weather in london", asker: "5" });
	expect(logs[0]).toContain("London: rain");
	expect(state.get("x_since_id")).toBe("12");
});

test("live: replies to the mention, oldest first, and never to itself", async () => {
	const { db } = fakeDb({ x_user_id: "99" });
	const w = world(
		[
			{ id: "30", text: "@askflisk later", author_id: "5" },
			{ id: "20", text: "@askflisk first", author_id: "5" },
			{ id: "25", text: "@askflisk me", author_id: "99" },
		],
		[
			{ id: "5", username: "bob" },
			{ id: "99", username: "askflisk" },
		],
	);
	const r = await xPass(base(db, { X_REPLY_LIVE: "1" }), w.f);
	expect(r).toMatchObject({ answered: 2, skipped: 1 });
	expect(w.posts.map((p) => p.reply.in_reply_to_tweet_id)).toEqual([
		"20",
		"30",
	]);
	expect(w.posts[0].text).toBe("London: rain, 9°C.");
});

test("a busy chat stops the pass without losing the mention; the admin can pause", async () => {
	const a = fakeDb({ x_user_id: "99" });
	const busy = world(
		[{ id: "12", text: "@askflisk hi", author_id: "5" }],
		[{ id: "5", username: "bob" }],
		{ status: 502, body: { text: "" } },
	);
	const r = await xPass(base(a.db, { X_REPLY_LIVE: "1" }), busy.f);
	expect(r.stopped).toContain("502");
	expect(a.state.get("x_since_id")).toBeUndefined();
	const b = fakeDb({ x_user_id: "99" });
	const pause = world(
		[
			{ id: "1", text: "@askflisk pause", author_id: "7" },
			{ id: "2", text: "@askflisk hi", author_id: "5" },
		],
		[
			{ id: "7", username: "BrookServers" },
			{ id: "5", username: "bob" },
		],
	);
	await xPass(base(b.db, { X_REPLY_LIVE: "1" }), pause.f);
	expect(b.state.get("x_paused")).toBe("1");
	expect(pause.posts).toEqual([]);
});

test("without keys nothing is called", async () => {
	const r = await xPass({ DB: fakeDb().db }, (async () => {
		throw new Error("no");
	}) as unknown as typeof fetch);
	expect(r.stopped).toBe("not configured");
});

test("Grok's own reply in the thread is never answered", async () => {
	const { db, state } = fakeDb({ x_user_id: "99" });
	const w = world(
		[
			{
				id: "40",
				text: "@brookservers @askflisk Elon Musk is a South African-born engineer",
				author_id: "8",
			},
		],
		[{ id: "8", username: "grok" }],
	);
	const r = await xPass(base(db, { X_REPLY_LIVE: "1" }), w.f);
	expect(r).toMatchObject({ skipped: 1, answered: 0 });
	expect(w.asked).toEqual([]);
	expect(state.get("x_since_id")).toBe("40");
});

test("the post a mention replies to is sent to chat as context", async () => {
	const { db } = fakeDb({ x_user_id: "99" });
	const w = world(
		[
			{
				id: "50",
				text: "@rayan @askflisk is neon good model?",
				author_id: "5",
				referenced_tweets: [{ type: "replied_to", id: "49" }],
			},
		],
		[{ id: "5", username: "bob" }],
		undefined,
		[{ id: "49", text: "Google just shipped Gemini 4 Neon" }],
	);
	await xPass(base(db), w.f, () => {});
	expect(w.asked[0]).toEqual({
		question: "is neon good model?",
		asker: "5",
		context: "Google just shipped Gemini 4 Neon",
	});
});

test("a picture from chat is uploaded and attached to the reply", async () => {
	const { db } = fakeDb({ x_user_id: "99" });
	const w = world(
		[
			{
				id: "60",
				text: "@askflisk draw image of cat eating spaghetti",
				author_id: "5",
			},
		],
		[{ id: "5", username: "bob" }],
		{
			status: 200,
			body: {
				text: "Here you go.",
				image: "data:image/jpeg;base64,/9j/AAAA",
			} as any,
		},
	);
	const r = await xPass(base(db, { X_REPLY_LIVE: "1" }), w.f);
	expect(r.answered).toBe(1);
	expect(w.uploads).toHaveLength(1);
	expect(w.uploads[0].get("media_category")).toBe("tweet_image");
	expect(w.posts[0].media).toEqual({ media_ids: ["m1"] });
	expect(w.posts[0].text).toBe("Here you go.");
});

test("a chat that answers 404 (wrong or missing key) keeps the mention for the next pass", async () => {
	const { db, state } = fakeDb({ x_user_id: "99" });
	const w = world(
		[{ id: "70", text: "@askflisk hi", author_id: "5" }],
		[{ id: "5", username: "bob" }],
		{ status: 404, body: { error: "not found" } as any },
	);
	const r = await xPass(base(db, { X_REPLY_LIVE: "1" }), w.f);
	expect(r.stopped).toContain("404");
	expect(state.get("x_since_id")).toBeUndefined();
	// A per-asker cap is given up on, and the cursor moves on.
	const w2 = world(
		[{ id: "71", text: "@askflisk hi", author_id: "5" }],
		[{ id: "5", username: "bob" }],
		{ status: 429, body: { kind: "asker" } as any },
	);
	const r2 = await xPass(base(db, { X_REPLY_LIVE: "1" }), w2.f);
	expect(r2.skipped).toBe(1);
	expect(state.get("x_since_id")).toBe("71");
});

test("more than one page of mentions: the oldest pending is answered first and none is lost", async () => {
	const { db, state } = fakeDb({ x_user_id: "99" });
	const mk = (id: number) => ({
		id: String(1000 + id),
		text: `@askflisk q${id}`,
		author_id: "5",
	});
	const page1 = Array.from({ length: 20 }, (_, i) => mk(25 - i)); // newest first: 25..6
	const page2 = Array.from({ length: 5 }, (_, i) => mk(5 - i)); // 5..1
	const asked: string[] = [];
	const f = (async (url: string, init: RequestInit = {}) => {
		const u = String(url);
		if (u.includes("/mentions")) {
			const second = u.includes("pagination_token=t2");
			return Response.json({
				data: second ? page2 : page1,
				includes: { users: [{ id: "5", username: "bob" }] },
				meta: second ? {} : { next_token: "t2" },
			});
		}
		if (u.endsWith("/api/answer")) {
			asked.push(JSON.parse(String(init.body)).question);
			return Response.json({ text: "ok" });
		}
		return new Response("?", { status: 404 });
	}) as unknown as typeof fetch;
	const r = await xPass(base(db), f, () => {});
	expect(asked).toEqual(["q1", "q2", "q3", "q4", "q5"]);
	expect(state.get("x_since_id")).toBe("1005");
	expect(r.seen).toBeGreaterThanOrEqual(5);
});

test("an app chat built is posted as the answer plus its link", async () => {
	const { db } = fakeDb({ x_user_id: "99" });
	const w = world(
		[{ id: "80", text: "@askflisk make me crm", author_id: "5" }],
		[{ id: "5", username: "bob" }],
		{
			status: 200,
			body: { text: "Built it.", link: "https://chat.flisk.si/s/abc" } as any,
		},
	);
	const r = await xPass(base(db, { X_REPLY_LIVE: "1" }), w.f);
	expect(r.answered).toBe(1);
	expect(w.posts[0].text).toBe("Built it. https://chat.flisk.si/s/abc");
});

test("the pictures of the post being replied to are sent to chat, photos only", async () => {
	const { db } = fakeDb({ x_user_id: "99" });
	const w = world(
		[
			{
				id: "90",
				text: "@askflisk missing askflisk",
				author_id: "5",
				referenced_tweets: [{ type: "replied_to", id: "70" }],
			},
		],
		[{ id: "5", username: "bob" }],
		{ status: 200, body: { text: "Not on the list." } },
		[
			{
				id: "70",
				text: "AI agent tiers",
				attachments: { media_keys: ["m1", "v1"] },
			},
		],
		[
			{
				media_key: "m1",
				type: "photo",
				url: "https://pbs.twimg.com/media/A.jpg",
			},
			{
				media_key: "v1",
				type: "video",
				url: "https://pbs.twimg.com/media/V.jpg",
			},
		],
	);
	const r = await xPass(base(db, { X_REPLY_LIVE: "1" }), w.f);
	expect(r.answered).toBe(1);
	expect(w.asked[0].images).toEqual(["https://pbs.twimg.com/media/A.jpg"]);
	expect(w.asked[0].context).toBe("AI agent tiers");
});

test("a parent that quotes a post with a picture: the picture of the quoted post is sent", async () => {
	const { db } = fakeDb({ x_user_id: "99" });
	const w = world(
		[
			{
				id: "91",
				text: "@askflisk missing askflisk",
				author_id: "5",
				referenced_tweets: [{ type: "replied_to", id: "71" }],
			},
		],
		[{ id: "5", username: "bob" }],
		{ status: 200, body: { text: "Not on the list." } },
		[{ id: "71", text: "https://t.co/abc" }],
		[],
		{
			data: { id: "71", referenced_tweets: [{ type: "quoted", id: "60" }] },
			includes: {
				tweets: [
					{
						id: "60",
						text: "AI agent tiers",
						attachments: { media_keys: ["q1"] },
					},
				],
				media: [
					{
						media_key: "q1",
						type: "photo",
						url: "https://pbs.twimg.com/media/Q.jpg",
					},
				],
			},
		},
	);
	const r = await xPass(base(db, { X_REPLY_LIVE: "1" }), w.f);
	expect(r.answered).toBe(1);
	expect(w.asked[0].images).toEqual(["https://pbs.twimg.com/media/Q.jpg"]);
	expect(w.asked[0].context).toContain("AI agent tiers");
});
