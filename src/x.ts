// @askflisk on X: someone posts "@askflisk weather in london", the bot answers as a reply, with the answer from chat.flisk.si
// (POST /api/answer: the same free model, live weather and web search as chat). A cron pass reads new mentions, oldest first,
// answers each once, and remembers the newest mention it has finished (D1 state `x_since_id`).
// X access: an app under the admin (@brookservers) with read+write, OAuth 1.0a user keys of @askflisk (4 secrets below).
// Nothing is posted until X_REPLY_LIVE=1: before that a pass only logs what it would say (a dry run).
import type { D1Like } from "./stores";

export interface XEnv {
	DB: D1Like;
	X_API_KEY?: string;
	X_API_SECRET?: string;
	X_ACCESS_TOKEN?: string;
	X_ACCESS_SECRET?: string;
	/** Secret, the same value as X_BOT_KEY on chat. */
	CHAT_ANSWER_KEY?: string;
	CHAT_URL?: string;
	/** The account that answers, no @. */
	X_HANDLE?: string;
	/** The admin account, no @. Its mentions can say "pause" or "resume". */
	X_ADMIN?: string;
	/** Accounts the bot never answers, comma separated, no @. Default: grok, so it does not answer Grok's own replies in a thread. */
	X_IGNORE?: string;
	X_REPLY_LIVE?: string;
	X_REPLIES_PER_PASS?: string;
}

const X_API = "https://api.x.com/2";
export const X_CONFIGURED = (e: XEnv) =>
	!!(
		e.X_API_KEY &&
		e.X_API_SECRET &&
		e.X_ACCESS_TOKEN &&
		e.X_ACCESS_SECRET &&
		e.CHAT_ANSWER_KEY
	);

const MAX_PAGES = 10;
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // OAuth sorts by byte value, not by locale
const enc = (s: string) =>
	encodeURIComponent(s).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

// OAuth 1.0a (HMAC-SHA1) Authorization header. Query values are part of the signature; a JSON body is not.
export async function oauthHeader(
	method: string,
	url: string,
	query: Record<string, string>,
	e: XEnv,
	nonce = crypto.randomUUID().replace(/-/g, ""),
	ts = String(Math.floor(Date.now() / 1000)),
): Promise<string> {
	const oauth: Record<string, string> = {
		oauth_consumer_key: e.X_API_KEY || "",
		oauth_nonce: nonce,
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: ts,
		oauth_token: e.X_ACCESS_TOKEN || "",
		oauth_version: "1.0",
	};
	const all = { ...query, ...oauth };
	const base = Object.keys(all)
		.sort(byCode)
		.map((k) => `${enc(k)}=${enc(all[k])}`)
		.join("&");
	const toSign = `${method.toUpperCase()}&${enc(url)}&${enc(base)}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(
			`${enc(e.X_API_SECRET || "")}&${enc(e.X_ACCESS_SECRET || "")}`,
		),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const sig = b64(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign)),
	);
	const fields = { ...oauth, oauth_signature: sig };
	return `OAuth ${Object.keys(fields)
		.sort(byCode)
		.map((k) => `${enc(k)}="${enc(fields[k as keyof typeof fields])}"`)
		.join(", ")}`;
}

interface Mention {
	id: string;
	text: string;
	author_id?: string;
	referenced_tweets?: { type: string; id: string }[];
	attachments?: { media_keys?: string[] };
}

// The pictures (photos only) of a post, as links chat can read.
export function photosOf(
	attachments: { media_keys?: string[] } | undefined,
	media: Map<string, string>,
): string[] {
	return (attachments?.media_keys || [])
		.map((k) => media.get(k) || "")
		.filter(Boolean);
}

// The question in a mention: the leading @handles (the reply chain) are dropped; what is left is what the person asked.
export function questionOf(text: string, handle: string): string {
	const t = String(text || "")
		.replace(/^(\s*@\w+)+/, " ")
		.replace(new RegExp(`@${handle}\\b`, "gi"), " ")
		.replace(/https?:\/\/t\.co\/\w+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return t.slice(0, 500);
}

const idGt = (a: string, b: string) =>
	a.length !== b.length ? a.length > b.length : a > b;
const getState = async (db: D1Like, k: string) =>
	(
		await db
			.prepare("SELECT v FROM state WHERE k = ?")
			.bind(k)
			.first<{ v: string }>()
	)?.v ?? null;
const setState = (db: D1Like, k: string, v: string) =>
	db
		.prepare(
			"INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
		)
		.bind(k, v)
		.run();

export interface PassResult {
	seen: number;
	answered: number;
	skipped: number;
	dry: number;
	stopped?: string;
}

export async function xPass(
	env: XEnv,
	fetchImpl: typeof fetch = fetch,
	log: (s: string) => void = (s) => console.log(s),
): Promise<PassResult> {
	const out: PassResult = { seen: 0, answered: 0, skipped: 0, dry: 0 };
	if (!X_CONFIGURED(env)) {
		out.stopped = "not configured";
		return out;
	}
	let paused = (await getState(env.DB, "x_paused")) === "1";
	const handle = (env.X_HANDLE || "askflisk").toLowerCase();
	const admin = (env.X_ADMIN || "brookservers").toLowerCase();
	const ignore = new Set(
		(env.X_IGNORE ?? "grok")
			.toLowerCase()
			.split(",")
			.map((x) => x.trim().replace(/^@/, ""))
			.filter(Boolean),
	);
	const live = env.X_REPLY_LIVE === "1";
	const call = async (
		method: string,
		path: string,
		query: Record<string, string> = {},
		body?: unknown,
	) => {
		const url = `${X_API}${path}`;
		const qs = Object.keys(query).length
			? `?${Object.keys(query)
					.sort(byCode)
					.map((k) => `${enc(k)}=${enc(query[k])}`)
					.join("&")}`
			: "";
		const res = await fetchImpl(url + qs, {
			method,
			headers: {
				authorization: await oauthHeader(method, url, query, env),
				...(body ? { "content-type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(8000),
		});
		return {
			status: res.status,
			json: (await res.json().catch(() => ({}))) as Record<string, any>,
		};
	};

	// A picture chat drew (a data: URL) is uploaded to X, and its id goes on the reply. null when X refuses it.
	const upload = async (dataUrl: string): Promise<string | null> => {
		const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
			dataUrl,
		);
		if (!m) return null;
		const form = new FormData();
		form.set(
			"media",
			new Blob([Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))], {
				type: m[1],
			}),
			"flisk.jpg",
		);
		form.set("media_category", "tweet_image");
		const url = `${X_API}/media/upload`;
		const res = await fetchImpl(url, {
			method: "POST",
			headers: { authorization: await oauthHeader("POST", url, {}, env) },
			body: form,
			signal: AbortSignal.timeout(20000),
		});
		const j = (await res.json().catch(() => ({}))) as {
			data?: { id?: string };
		};
		return res.status < 300 ? (j?.data?.id ?? null) : null;
	};

	// The link of an app goes to the asker by DM: X drops posts that carry a link. true when X took the message.
	const dm = async (userId: string, text: string): Promise<boolean> => {
		const r = await call("POST", `/dm_conversations/with/${userId}/messages`, {}, { text });
		return r.status === 201;
	};

	let me = await getState(env.DB, "x_user_id");
	if (!me) {
		const r = await call("GET", "/users/me");
		me = r.json?.data?.id ?? null;
		if (!me) {
			out.stopped = `could not read the account (${r.status})`;
			return out;
		}
		await setState(env.DB, "x_user_id", me);
	}
	const since = await getState(env.DB, "x_since_id");
	const q: Record<string, string> = {
		max_results: "20",
		"tweet.fields": "author_id,referenced_tweets,created_at,attachments",
		expansions:
			"author_id,referenced_tweets.id,attachments.media_keys,referenced_tweets.id.attachments.media_keys",
		"media.fields": "type,url",
		"user.fields": "username",
	};
	if (since) q.since_id = since;
	// X returns mentions newest first, 20 a page. All pages since the last finished mention are read before anything is answered, so
	// the oldest pending mention is always answered first and none is passed over. A page that fails stops the pass: answering only
	// the newer pages would move the cursor past the older ones. (More than MAX_PAGES x 20 pending, an old backlog: the oldest are dropped.)
	const all: Mention[] = [];
	const parents = new Map<string, string>();
	const parentMedia = new Map<string, { media_keys?: string[] }>();
	const photos = new Map<string, string>();
	const names = new Map<string, string>();
	let token: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const r = await call(
			"GET",
			`/users/${me}/mentions`,
			token ? { ...q, pagination_token: token } : q,
		);
		if (r.status !== 200) {
			out.stopped = `mentions answered ${r.status}`;
			return out;
		}
		all.push(...((r.json.data || []) as Mention[]));
		// The post each mention replies to (X sends it along with the mention), so a question like "is neon good?" has its topic.
		for (const t of (r.json.includes?.tweets || []) as {
			id: string;
			text: string;
			attachments?: { media_keys?: string[] };
		}[]) {
			parents.set(t.id, t.text);
			if (t.attachments) parentMedia.set(t.id, t.attachments);
		}
		for (const md of (r.json.includes?.media || []) as {
			media_key: string;
			type: string;
			url?: string;
		}[])
			if (md.type === "photo" && md.url) photos.set(md.media_key, md.url);
		for (const u of (r.json.includes?.users || []) as {
			id: string;
			username: string;
		}[])
			names.set(u.id, u.username.toLowerCase());
		token = r.json.meta?.next_token;
		if (!token) break;
	}
	const list = all.sort((a, b) => (idGt(a.id, b.id) ? 1 : -1));
	const cap = Number(env.X_REPLIES_PER_PASS) || 5;
	let handled = 0;
	for (const m of list) {
		out.seen++;
		if (handled >= cap) break; // the rest wait for the next pass: since_id has not moved past them
		const who = names.get(m.author_id || "") || "";
		const done = async () => {
			await setState(env.DB, "x_since_id", m.id);
		};
		if (
			m.author_id === me ||
			ignore.has(who) ||
			who === handle ||
			(m.referenced_tweets || []).some((t) => t.type === "retweeted")
		) {
			out.skipped++;
			await done();
			continue;
		}
		const question = questionOf(m.text, handle);
		if (who === admin && /^(pause|stop)\b/i.test(question)) {
			await setState(env.DB, "x_paused", "1");
			paused = true;
			out.stopped = "paused";
			out.skipped++;
			await done();
			continue;
		}
		if (who === admin && /^(resume|start)\b/i.test(question)) {
			await setState(env.DB, "x_paused", "0");
			paused = false;
			out.stopped = undefined;
			out.skipped++;
			await done();
			continue;
		}
		if (paused) {
			out.skipped++;
			await done();
			continue;
		} // paused: mentions are not answered, and not kept for later
		if (!question) {
			out.skipped++;
			await done();
			continue;
		}
		handled++;
		const parentId = (m.referenced_tweets || []).find(
			(t) => t.type === "replied_to",
		)?.id;
		// The pictures of the post being replied to, then the mention's own: "is this ranking right?" is about the picture.
		const images = [
			...photosOf(parentMedia.get(parentId || ""), photos),
			...photosOf(m.attachments, photos),
		];
		// A parent that is a quote post (or shows only links) keeps its picture on the post it quotes: look that post up too.
		let context = parents.get(parentId || "");
		if (!images.length && parentId) {
			const r = await call("GET", `/tweets/${parentId}`, {
				"tweet.fields": "attachments,referenced_tweets",
				expansions:
					"attachments.media_keys,referenced_tweets.id,referenced_tweets.id.attachments.media_keys",
				"media.fields": "type,url",
			}).catch(() => null);
			if (r && r.status === 200) {
				const found = new Map<string, string>();
				for (const md of (r.json.includes?.media || []) as {
					media_key: string;
					type: string;
					url?: string;
				}[])
					if (md.type === "photo" && md.url) found.set(md.media_key, md.url);
				const quoted = (r.json.includes?.tweets || []) as {
					text: string;
					attachments?: { media_keys?: string[] };
				}[];
				images.push(
					...photosOf(r.json.data?.attachments, found),
					...quoted.flatMap((t) => photosOf(t.attachments, found)),
				);
				if (quoted[0]?.text)
					context = `${context || ""} ${quoted[0].text}`.trim();
			}
		}
		images.splice(2);
		const chat = (env.CHAT_URL || "https://chat.flisk.si").replace(/\/+$/, "");
		const a = await fetchImpl(`${chat}/api/answer`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${env.CHAT_ANSWER_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				question,
				asker: m.author_id,
				...(images.length ? { images } : {}),
				context,
			}),
			signal: AbortSignal.timeout(25000),
		}).catch(() => null);
		// A busy model or an out-of-answers day: stop here, the same mention is tried again next pass. A per-asker cap: skip that one.
		if (!a || a.status >= 500) {
			out.stopped = `chat answered ${a?.status ?? "nothing"}`;
			break;
		}
		const body = (await a.json().catch(() => ({}))) as {
			text?: string;
			image?: string;
			link?: string;
			kind?: string;
		};
		if (a.status === 429 && body.kind === "day") {
			out.stopped = "chat is out of answers today";
			break;
		}
		if (!(a.status === 200 && body.text)) {
			// Only what is about this one asker is given up on: their daily cap, or a question chat cannot read. Anything else (a wrong or missing
			// key is a 404, a 401, a 403) is about the service, not the mention: stop and keep the mention for the next pass.
			if ((a.status === 429 && body.kind === "asker") || a.status === 400) {
				out.skipped++;
				await done();
				continue;
			}
			out.stopped = `chat answered ${a.status}`;
			break;
		}
		if (!live) {
			log(
				`x dry run: @${who} asked "${question}" -> "${body.text}"${body.image ? ` (+ picture, ${body.image.length} chars)` : ""}`,
			);
			out.dry++;
			await done();
			continue;
		}
		const mediaId = body.image
			? await upload(body.image).catch(() => null)
			: null;
		// An app with its picture: the post shows the picture and the link goes by DM. If either step fails the link goes in the post as before.
		const dmSent =
			body.link && mediaId
				? await dm(m.author_id, `${body.text} ${body.link}`).catch(() => false)
				: false;
		const tweetText = dmSent
			? `${body.text} I sent you the link in a DM.`
			: body.link
				? `${body.text} ${body.link}`
				: body.text;
		const post = await call(
			"POST",
			"/tweets",
			{},
			{
				text:
					body.image && !mediaId && !body.link
						? "I drew it but X would not take the picture. Try again in a minute."
						: tweetText,
				reply: { in_reply_to_tweet_id: m.id },
				...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
			},
		);
		if (post.status === 201) {
			out.answered++;
			await done();
			continue;
		}
		// 403 duplicate/forbidden for this one mention: give up on it. Anything else (429, 5xx): try again next pass.
		if (post.status === 403) {
			out.skipped++;
			await done();
			continue;
		}
		out.stopped = `posting answered ${post.status}`;
		break;
	}
	return out;
}
