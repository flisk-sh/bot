// @askflisk on Bluesky: the second front of the same bot as x.ts. Someone posts "@askflisk.bsky.social weather in london" (or replies to
// the bot), and the bot answers as a reply with the answer from chat.flisk.si (POST /api/answer: the same free model, live weather,
// web search, app and game builds). A cron pass reads new notifications (mentions and replies), oldest first, answers each once, and
// remembers the time of the newest one it has finished (D1 state `bsky_since`).
// Access: an app password of the account (Bluesky settings -> Privacy and security -> App passwords), secrets BSKY_HANDLE and
// BSKY_APP_PASSWORD. The session tokens are kept in D1 state `bsky_session` (the app password itself never is).
// Nothing is posted until BSKY_REPLY_LIVE=1: before that a pass only logs what it would say (a dry run).
// Only fetch against the AT Protocol XRPC API, no SDK.
import type { D1Like } from "./stores";

export interface BskyEnv {
	DB: D1Like;
	/** Secret. The account that answers, e.g. askflisk.bsky.social (a handle or a DID). */
	BSKY_HANDLE?: string;
	/** Secret. An app password of that account, never the main password. */
	BSKY_APP_PASSWORD?: string;
	/** Secret, the same value as X_BOT_KEY on chat (also used by the X pass). */
	CHAT_ANSWER_KEY?: string;
	CHAT_URL?: string;
	/** The server of the account. Default https://bsky.social. */
	BSKY_PDS?: string;
	/** Accounts that can say "pause" or "resume" to the bot, comma separated, no @. Default: nobody. */
	BSKY_ADMIN?: string;
	/** Accounts the bot never answers, comma separated, no @. */
	BSKY_IGNORE?: string;
	BSKY_REPLY_LIVE?: string;
	BSKY_REPLIES_PER_PASS?: string;
	/** Replies an hour (default 8) and a day (default 60): an account that answers too much gets hidden. */
	BSKY_REPLIES_PER_HOUR?: string;
	BSKY_REPLIES_PER_DAY?: string;
}

export const BSKY_CONFIGURED = (e: BskyEnv) =>
	!!(e.BSKY_HANDLE && e.BSKY_APP_PASSWORD && e.CHAT_ANSWER_KEY);

export const MAX_GRAPHEMES = 300;
const MAX_PAGES = 5;
const MAX_BLOB = 950_000; // Bluesky takes a picture up to 1 MB
const FIRST_RUN_WINDOW_MS = 10 * 60_000; // no cursor yet: only look at the last 10 minutes, never the whole backlog
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const bucket = (size: number) => String(Math.floor(Date.now() / size));
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
// Replies sent in the current hour or day: state "<bucket>:<count>", a new bucket starts at 0.
const sentIn = async (db: D1Like, key: string, size: number) => {
	const [b, n] = String((await getState(db, key)) || "").split(":");
	return b === bucket(size) ? Number(n) || 0 : 0;
};

const graphemes = (s: string): string[] =>
	Array.from(
		new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s),
		(x) => x.segment,
	);

// The question in a mention: the @handles of the bot are dropped; what is left is what the person asked.
export function questionOf(text: string, handle: string): string {
	const full = handle.toLowerCase().replace(/^@/, "");
	const short = full.split(".")[0];
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return String(text || "")
		.replace(new RegExp(`@${esc(full)}`, "gi"), " ")
		.replace(new RegExp(`@${esc(short)}\\b`, "gi"), " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}

// Fit the answer (and its link) in one post of 300 characters (graphemes). The link is kept whole, the text is cut with an ellipsis.
export function fitPost(text: string, link?: string): string {
	const tail = link ? ` ${link}` : "";
	const room = MAX_GRAPHEMES - graphemes(tail).length;
	const g = graphemes(text.trim());
	const body =
		g.length > room
			? `${g
					.slice(0, Math.max(0, room - 1))
					.join("")
					.trimEnd()}…`
			: g.join("");
	return body + tail;
}

export interface Facet {
	index: { byteStart: number; byteEnd: number };
	features: { $type: "app.bsky.richtext.facet#link"; uri: string }[];
}

// Link facets for every http(s) link in the text. Bluesky positions are UTF-8 byte offsets, not characters.
export function linkFacets(text: string): Facet[] {
	const enc = new TextEncoder();
	const out: Facet[] = [];
	for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
		const url = m[0].replace(/[.,;:!?)\]}'"]+$/, "");
		if (!url) continue;
		const byteStart = enc.encode(text.slice(0, m.index)).length;
		out.push({
			index: { byteStart, byteEnd: byteStart + enc.encode(url).length },
			features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
		});
	}
	return out;
}

interface View {
	uri?: string;
	cid?: string;
	author?: { did?: string; handle?: string };
	record?: { text?: string; reply?: { root?: Ref; parent?: Ref } };
	embed?: Embed;
}
interface Ref {
	uri: string;
	cid: string;
}
interface Embed {
	$type?: string;
	images?: { thumb?: string; fullsize?: string }[];
	thumbnail?: string;
	media?: Embed;
	record?: Embed & {
		record?: Embed;
		value?: { text?: string };
		embeds?: Embed[];
	};
	embeds?: Embed[];
	value?: { text?: string };
}

// The pictures of a post as links chat can read: photos, and the preview frame of a video. The posts it quotes count too.
export function picturesOf(embed: Embed | undefined): string[] {
	if (!embed) return [];
	const own = [
		...(embed.images || []).map((i) => i.thumb || i.fullsize || ""),
		embed.thumbnail || "",
	];
	// A quote post: {record: viewRecord{embeds}}; a quote with media: {media, record: {record: viewRecord{embeds}}}.
	const quoted = embed.record?.record ?? embed.record;
	const inner = [
		...picturesOf(embed.media),
		...((quoted?.embeds as Embed[] | undefined) || []).flatMap(picturesOf),
	];
	return [...own, ...inner].filter((u) =>
		/^https:\/\/(?:cdn|video)\.bsky\.app\//.test(u),
	);
}
const quoteText = (embed: Embed | undefined): string => {
	const rec = embed?.record?.record ?? embed?.record;
	return String(rec?.value?.text || "");
};

interface Notification {
	uri: string;
	cid: string;
	reason: string;
	indexedAt: string;
	author: { did: string; handle: string };
	record?: { text?: string; reply?: { root?: Ref; parent?: Ref } };
}

export interface PassResult {
	seen: number;
	answered: number;
	skipped: number;
	dry: number;
	stopped?: string;
}

interface Session {
	did: string;
	accessJwt: string;
	refreshJwt: string;
}

export async function bskyPass(
	env: BskyEnv,
	fetchImpl: typeof fetch = fetch,
	log: (s: string) => void = (s) => console.log(s),
): Promise<PassResult> {
	const out: PassResult = { seen: 0, answered: 0, skipped: 0, dry: 0 };
	if (!BSKY_CONFIGURED(env)) {
		out.stopped = "not configured";
		return out;
	}
	const pds = (env.BSKY_PDS || "https://bsky.social").replace(/\/+$/, "");
	const own = String(env.BSKY_HANDLE).toLowerCase().replace(/^@/, "");
	const list = (s?: string) =>
		new Set(
			String(s ?? "")
				.toLowerCase()
				.split(",")
				.map((x) => x.trim().replace(/^@/, ""))
				.filter(Boolean),
		);
	const admin = list(env.BSKY_ADMIN);
	const ignore = list(env.BSKY_IGNORE);
	const live = env.BSKY_REPLY_LIVE === "1";
	let paused = (await getState(env.DB, "bsky_paused")) === "1";

	const raw = async (
		method: string,
		nsid: string,
		opts: {
			query?: URLSearchParams;
			json?: unknown;
			bytes?: { type: string; data: Uint8Array };
			token?: string;
			timeout?: number;
		} = {},
	) => {
		const qs = opts.query?.toString();
		const headers: Record<string, string> = {};
		if (opts.token) headers.authorization = `Bearer ${opts.token}`;
		let body: BodyInit | undefined;
		if (opts.json !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(opts.json);
		} else if (opts.bytes) {
			headers["content-type"] = opts.bytes.type;
			body = opts.bytes.data as unknown as BodyInit;
		}
		const res = await fetchImpl(`${pds}/xrpc/${nsid}${qs ? `?${qs}` : ""}`, {
			method,
			headers,
			...(body !== undefined ? { body } : {}),
			signal: AbortSignal.timeout(opts.timeout ?? 8000),
		});
		return {
			status: res.status,
			json: (await res.json().catch(() => ({}))) as Record<string, any>,
		};
	};

	// The stored session; when it is gone or refused, refresh it, and when that fails log in again with the app password.
	let session: Session | null = null;
	try {
		session = JSON.parse((await getState(env.DB, "bsky_session")) || "null");
	} catch {
		session = null;
	}
	const save = async (j: Record<string, any>) => {
		if (!j.accessJwt || !j.refreshJwt || !j.did) return null;
		session = { did: j.did, accessJwt: j.accessJwt, refreshJwt: j.refreshJwt };
		await setState(env.DB, "bsky_session", JSON.stringify(session));
		return session;
	};
	const login = async () => {
		const r = await raw("POST", "com.atproto.server.createSession", {
			json: { identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD },
		});
		return r.status === 200 ? save(r.json) : null;
	};
	const renew = async () => {
		if (session?.refreshJwt) {
			const r = await raw("POST", "com.atproto.server.refreshSession", {
				token: session.refreshJwt,
			});
			if (r.status === 200 && (await save(r.json))) return session;
		}
		return login();
	};
	// An authenticated call; a refused token is renewed once and the call repeated.
	const call = async (
		method: string,
		nsid: string,
		opts: {
			query?: URLSearchParams;
			json?: unknown;
			bytes?: { type: string; data: Uint8Array };
			timeout?: number;
		} = {},
	) => {
		if (!session && !(await login())) return { status: 401, json: {} };
		let r = await raw(method, nsid, { ...opts, token: session?.accessJwt });
		if (
			r.status === 401 ||
			(r.status === 400 && r.json.error === "ExpiredToken")
		) {
			if (!(await renew())) return { status: 401, json: {} };
			r = await raw(method, nsid, { ...opts, token: session?.accessJwt });
		}
		return r;
	};

	// The first call also proves the login works.
	const stored = await getState(env.DB, "bsky_since");
	const since = stored ? Date.parse(stored) : Date.now() - FIRST_RUN_WINDOW_MS;
	// Notifications come newest first, 50 a page. All pages down to the last finished one are read before anything is answered, so the
	// oldest pending one is answered first and none is passed over. A page that fails stops the pass.
	const all = new Map<string, Notification>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const q = new URLSearchParams({ limit: "50" });
		q.append("reasons", "mention");
		q.append("reasons", "reply");
		if (cursor) q.set("cursor", cursor);
		const r = await call("GET", "app.bsky.notification.listNotifications", {
			query: q,
		});
		if (r.status !== 200) {
			out.stopped = `notifications answered ${r.status}`;
			return out;
		}
		const got = (r.json.notifications || []) as Notification[];
		let reachedOld = false;
		for (const n of got) {
			if (Date.parse(n.indexedAt) <= since) reachedOld = true;
			else if (n.reason === "mention" || n.reason === "reply")
				all.set(n.uri, n);
		}
		cursor = r.json.cursor;
		if (!cursor || reachedOld || !got.length) break;
	}
	const me = session?.did || "";
	const queue = [...all.values()].sort(
		(a, b) => Date.parse(a.indexedAt) - Date.parse(b.indexedAt),
	);
	const cap = Number(env.BSKY_REPLIES_PER_PASS) || 2;
	const perHour = Number(env.BSKY_REPLIES_PER_HOUR) || 8;
	const perDay = Number(env.BSKY_REPLIES_PER_DAY) || 60;
	const countSent = async () => {
		for (const [key, size] of [
			["bsky_hour", HOUR],
			["bsky_day", DAY],
		] as const)
			await setState(
				env.DB,
				key,
				`${bucket(size)}:${(await sentIn(env.DB, key, size)) + 1}`,
			);
	};

	// A picture chat drew (a data: URL) is uploaded as a blob. null when Bluesky refuses it or it is over 1 MB.
	const upload = async (dataUrl: string) => {
		const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
			dataUrl,
		);
		if (!m) return null;
		const data = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
		if (data.length > MAX_BLOB) return null;
		const r = await call("POST", "com.atproto.repo.uploadBlob", {
			bytes: { type: m[1], data },
			timeout: 20000,
		});
		return r.status === 200 ? (r.json.blob ?? null) : null;
	};

	let handled = 0;
	for (const n of queue) {
		out.seen++;
		if (handled >= cap) break; // the rest wait for the next pass: the cursor has not moved past them
		const who = (n.author?.handle || "").toLowerCase();
		const done = async () => {
			await setState(env.DB, "bsky_since", n.indexedAt);
		};
		if (n.author?.did === me || who === own || ignore.has(who)) {
			out.skipped++;
			await done();
			continue;
		}
		const question = questionOf(n.record?.text || "", own);
		if (admin.has(who) && /^(pause|stop)\b/i.test(question)) {
			await setState(env.DB, "bsky_paused", "1");
			paused = true;
			out.stopped = "paused";
			out.skipped++;
			await done();
			continue;
		}
		if (admin.has(who) && /^(resume|start)\b/i.test(question)) {
			await setState(env.DB, "bsky_paused", "0");
			paused = false;
			out.stopped = undefined;
			out.skipped++;
			await done();
			continue;
		}
		if (paused || !question) {
			out.skipped++;
			await done();
			continue;
		}
		// Too many replies for this hour or day: stop here, the mention is answered later.
		if (
			(await sentIn(env.DB, "bsky_hour", HOUR)) >= perHour ||
			(await sentIn(env.DB, "bsky_day", DAY)) >= perDay
		) {
			out.stopped = "reply cap reached for now";
			break;
		}
		handled++;
		// The post being replied to, and the post it quotes: their text is the context, their pictures are read.
		const parentRef = n.record?.reply?.parent;
		const uris = [n.uri, ...(parentRef ? [parentRef.uri] : [])];
		const g = new URLSearchParams();
		for (const u of uris) g.append("uris", u);
		const posts = await call("GET", "app.bsky.feed.getPosts", {
			query: g,
		}).catch(() => null);
		const views = new Map<string, View>(
			((posts?.json.posts || []) as View[]).map((p) => [p.uri || "", p]),
		);
		const parent = parentRef ? views.get(parentRef.uri) : undefined;
		const images = [
			...picturesOf(parent?.embed),
			...picturesOf(views.get(n.uri)?.embed),
		].slice(0, 2);
		const context =
			[parent?.record?.text, quoteText(parent?.embed)]
				.filter(Boolean)
				.join(" ")
				.trim() || undefined;
		const chat = (env.CHAT_URL || "https://chat.flisk.si").replace(/\/+$/, "");
		const a = await fetchImpl(`${chat}/api/answer`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${env.CHAT_ANSWER_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				question,
				asker: `bsky:${n.author.did}`,
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
				`bluesky dry run: @${who} asked "${question}" -> "${body.text}"${body.link ? ` ${body.link}` : ""}${body.image ? ` (+ picture, ${body.image.length} chars)` : ""}${images.length ? ` [read ${images.length} picture(s)]` : ""}`,
			);
			out.dry++;
			await done();
			continue;
		}
		const blob = body.image ? await upload(body.image).catch(() => null) : null;
		const text = fitPost(
			body.image && !blob
				? "I drew it but Bluesky would not take the picture. Try again in a minute."
				: body.text,
			body.link,
		);
		const parentOfReply: Ref = { uri: n.uri, cid: n.cid };
		const root = n.record?.reply?.root ?? parentOfReply;
		const facets = linkFacets(text);
		const post = await call("POST", "com.atproto.repo.createRecord", {
			json: {
				repo: me,
				collection: "app.bsky.feed.post",
				record: {
					$type: "app.bsky.feed.post",
					text,
					createdAt: new Date().toISOString(),
					reply: { root, parent: parentOfReply },
					...(facets.length ? { facets } : {}),
					...(blob
						? {
								embed: {
									$type: "app.bsky.embed.images",
									images: [
										{ alt: "A picture drawn for the answer", image: blob },
									],
								},
							}
						: {}),
				},
			},
		});
		if (post.status === 200) {
			out.answered++;
			await countSent();
			await done();
			continue;
		}
		// 400 for this one mention (a deleted post, a blocked thread): give up on it. Anything else (429, 5xx, a lost login): next pass.
		if (post.status === 400) {
			out.skipped++;
			await done();
			continue;
		}
		out.stopped = `posting answered ${post.status}`;
		break;
	}
	return out;
}
