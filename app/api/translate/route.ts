import { NextRequest, NextResponse } from "next/server";
import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  type ZhouliLevel,
  type ZhouliMode,
} from "@/lib/prompt";

export const runtime = "nodejs";

const VALID_MODES = new Set<ZhouliMode>([
  "gentle",
  "debate",
  "defend",
  "lament",
]);
const VALID_LEVELS = new Set<ZhouliLevel>(["light", "standard", "grand"]);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_WINDOW_LIMIT = 12;
const RATE_DAY_LIMIT = 60;

type RateRecord = {
  windowStartedAt: number;
  count: number;
  day: string;
  dayCount: number;
};

const globalForRateLimit = globalThis as typeof globalThis & {
  zhouliRateLimit?: Map<string, RateRecord>;
};

const rateLimit = globalForRateLimit.zhouliRateLimit ?? new Map();
globalForRateLimit.zhouliRateLimit = rateLimit;

function getClientKey(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "local";
  const clientId = request.headers.get("x-client-id") || "anonymous";
  return `${ip}:${clientId.slice(0, 80)}`;
}

function getShanghaiDay(now: number) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function secondsUntilNextShanghaiDay(now: number) {
  const shanghaiNow = new Date(now + 8 * 60 * 60 * 1000);
  const nextShanghaiMidnightUtc =
    Date.UTC(
      shanghaiNow.getUTCFullYear(),
      shanghaiNow.getUTCMonth(),
      shanghaiNow.getUTCDate() + 1,
    ) -
    8 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((nextShanghaiMidnightUtc - now) / 1000));
}

function checkRateLimit(key: string) {
  const now = Date.now();
  const today = getShanghaiDay(now);
  const current = rateLimit.get(key);

  if (!current || current.day !== today) {
    rateLimit.set(key, {
      windowStartedAt: now,
      count: 1,
      day: today,
      dayCount: 1,
    });
    return {
      allowed: true,
      remaining: Math.min(RATE_WINDOW_LIMIT - 1, RATE_DAY_LIMIT - 1),
      windowRemaining: RATE_WINDOW_LIMIT - 1,
      dailyRemaining: RATE_DAY_LIMIT - 1,
      retryAfterSeconds: 0,
    };
  }

  if (now - current.windowStartedAt > RATE_WINDOW_MS) {
    current.windowStartedAt = now;
    current.count = 0;
  }

  const dailyRemainingBefore = Math.max(0, RATE_DAY_LIMIT - current.dayCount);
  const windowRemainingBefore = Math.max(0, RATE_WINDOW_LIMIT - current.count);

  if (current.dayCount >= RATE_DAY_LIMIT) {
    return {
      allowed: false,
      reason: "day" as const,
      remaining: 0,
      windowRemaining: windowRemainingBefore,
      dailyRemaining: 0,
      retryAfterSeconds: secondsUntilNextShanghaiDay(now),
    };
  }

  if (current.count >= RATE_WINDOW_LIMIT) {
    return {
      allowed: false,
      reason: "window" as const,
      remaining: 0,
      windowRemaining: 0,
      dailyRemaining: dailyRemainingBefore,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.windowStartedAt + RATE_WINDOW_MS - now) / 1000),
      ),
    };
  }

  current.count += 1;
  current.dayCount += 1;
  rateLimit.set(key, current);
  const dailyRemaining = Math.max(0, RATE_DAY_LIMIT - current.dayCount);
  const windowRemaining = Math.max(0, RATE_WINDOW_LIMIT - current.count);
  return {
    allowed: true,
    remaining: Math.min(dailyRemaining, windowRemaining),
    windowRemaining,
    dailyRemaining,
    retryAfterSeconds: 0,
  };
}

function demoResult(text: string, mode: ZhouliMode, level: ZhouliLevel) {
  const subject = text.replace(/[。！？!?]+$/g, "");
  const openings: Record<ZhouliMode, string> = {
    gentle:
      "我听说，古代有贤德的人，在与朋友相处的时候，从不会因为一时的言语就忘记彼此长久的情分。",
    debate:
      "我听说，判断一件事情是否合乎礼，不能只看它表面的样子，还要看它最后使人得到了什么。",
    defend:
      "有人认为这件事不够稳妥，我却不这样看。古代的君子并不是从不犯错，而是懂得给每一种行为找到合适的名分。",
    lament:
      "从前的人把细小的事情看得很重，因为他们知道，礼法的败坏往往不是从朝堂开始，而是从一次漫不经心开始。",
  };

  const endings: Record<ZhouliMode, string> = {
    gentle:
      "如今既然事情已经发生，与其急着责怪，不如把话说明白、把情分留下。能够让彼此体面，难道不也是一种合乎周礼的做法吗？",
    debate:
      "这样看来，真正需要讨论的不是这句话听起来是否漂亮，而是它有没有让事情变得更好。若能如此，它离君子之言也就不远了。",
    defend:
      "所以这件事看似随意，实际上既保全了自己的本心，也没有损害别人。能够两全其美，怎么能说它完全不合乎周礼呢？",
    lament:
      `而现在竟有人说出“${subject}”，却不曾想过一句话也有它应当承担的分量。长此以往，人与人之间还凭什么相信彼此呢？`,
  };

  const middle =
    level === "light"
      ? `现在有人说“${subject}”，这句话虽然寻常，其中却也有可以体谅的地方。`
      : `当年有人行路匆忙，仍会在经过长者身旁时放慢脚步，不是因为道路难走，而是因为他知道自己的方便，不该成为别人的冒犯。现在有人说“${subject}”，表面看只是随口一说，其实也应当看看这句话落在别人心里，会有怎样的分量。`;

  return `${openings[mode]}${middle}${endings[mode]}`;
}

function cleanGeneratedText(value: string) {
  return value
    .replace(
      /(?:我听说)?(?:从前|当年|古时候|古代)?有(?:一位|一个|位|个)?(?:贤人|贤者|长者)[^。！？!?]{0,10}(?:说过|讲过)[，,：:]*/g,
      "我听说从前有个贤人，",
    )
    .replace(/(?:圣人|古人|孔子|周公)(?:云|曰|说)[，,：:]*/g, "若按礼法来看，")
    .replace(/《[^》]{1,12}》(?:所言|有云|曰|云|说|记载)[，,：:]*/g, "若按礼法来看，")
    .replace(/这正是我担忧的啊[，,。！？!?]*/g, "")
    .replace(/(?:你且想想|你好好想想|仔细想想)(?:其中的道理)?[，,、：:]*/g, "")
    .replace(/这其中的道理[，,、：:]*/g, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isDirectedSecondPersonAttackInput(text: string) {
  const hasFirstToSecondPerson =
    /(^\s*我|我想|我要|我会|我准备|我打算).{0,18}(你|你的|你们|您|贵方)/.test(
      text,
    );
  const hasAttackSignal =
    /(死|杀|打|弄|操|干|骂|喷|怼|草|艹|妈|母|全家|傻|滚|去死)/.test(
      text,
    );
  return hasFirstToSecondPerson && hasAttackSignal;
}

function hasDirectedAttackPerspectiveError(result: string) {
  return /你出言粗鄙|阁下说出|阁下开口|阁下这番话|你骂了我|你伤了我|对方骂我|被无礼之言所伤|你以禽兽之名相辱|以禽兽之名相辱|你把.{0,16}话|你却将|你却把|对人父母出言不逊|先问自己|我可曾|开口的人自己失礼|失礼的是我|我乱了本心|我该退后一步|我该重新想想|我分寸守不住|三省吾身/.test(
    result,
  );
}

function directedAttackFallback(text: string, level: ZhouliLevel) {
  const familyClause = /(妈|母|父|爹|娘|爸|亲族|全家)/.test(text)
    ? "父母亲族之名，本不该被卷入口角。"
    : "人身安危之事，本不该被拿来当口角筹码。";

  if (level === "light") {
    return `我今日有怒，并非无端。只是眼前这番争执，已经越过人与人相处的分寸。${familyClause}我把这怒意收成一句：此事若还讲礼数，就该到此为止。`;
  }

  if (level === "grand") {
    return `我今日有怒，并非无端。人与人相处，最怕一时口角越过分寸，把原本该讲清的事，变成彼此失礼的争斗。${familyClause}若按礼法来看，怒气可以有，名分不能乱；争执可以起，体面不能尽失。好比席间杯盏相碰，本是寻常声响，若有人借此掀翻整张筵席，便不是争胜，而是乱了席位。如今这番局面，已经到了该收束的时候。我把话说清：此事若还要留一点礼数，就该止于此处。`;
  }

  return `我今日有怒，并非无端。人与人相处，最怕一时口角越过分寸。${familyClause}若按礼法来看，怒气可以有，名分不能乱；争执可以起，体面不能尽失。我把话说清：此事若还要留一点礼数，就该止于此处。`;
}

function normalizeDirectedAttackResult(
  text: string,
  result: string,
  level: ZhouliLevel,
) {
  if (
    isDirectedSecondPersonAttackInput(text) &&
    hasDirectedAttackPerspectiveError(result)
  ) {
    return directedAttackFallback(text, level);
  }

  return result;
}

function isFirstPersonWorkThanksInput(text: string) {
  const mentionsMyWork =
    /(我做|我建|我造|我发|我的).{0,30}(网站|网页|视频|作品|工具|项目|应用|skill|Skill)|观众感谢我|别人夸我|粉丝夸我|用户感谢我/.test(
      text,
    );
  const asksForReply = /(感谢我|夸我|如何回复|怎么回复|怎么说|如何说)/.test(
    text,
  );
  return mentionsMyWork && asksForReply;
}

function hasFirstPersonWorkPerspectiveError(result: string) {
  return /你做网站|你做了|您做了|你建了|您建了|你造了|您造了|你发了|您发了|你若|你安了心|他们来谢|大家感谢你|观众感谢你|粉丝感谢你/.test(
    result,
  );
}

function firstPersonWorkThanksFallback(level: ZhouliLevel) {
  if (level === "light") {
    return "我做此物，本是想让它有一点用处。诸位愿意来看、愿意称谢，便是给了它体面。我只回一句：不敢当，诸位用得上，就是它最好的本分。";
  }

  if (level === "grand") {
    return "我做此物，本不是为了让众人把名分都归到我身上，只是想把一点可用的东西摆到席间，让需要的人伸手便能取用。如今诸位愿意来看，又肯相谢，这份情分我自然记在心里。可若我坦然独受，便好像席上端来一壶酒，却忘了同席的人也都出了兴致。所以我只宜这样回应：不敢当，诸位用得上，便是此物最大的本分；若觉得有趣，也请转告同好，让这点小礼多走几步。这样既接住了谢意，也把体面还给了众人。";
  }

  return "我做这个网站，本是想让一点礼数变成人人都能取用的小器物。如今诸位愿意来看，又肯相谢，这份情分我自然记在心里。若要回复，我只说：不敢当，诸位用得上，便是这网站最好的本分；若觉得有趣，也请转告同好，让这点小礼多走几步。";
}

function normalizeFirstPersonWorkResult(
  text: string,
  result: string,
  level: ZhouliLevel,
) {
  if (
    isFirstPersonWorkThanksInput(text) &&
    hasFirstPersonWorkPerspectiveError(result)
  ) {
    return firstPersonWorkThanksFallback(level);
  }

  return result;
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchDeepSeekWithRetry(
  apiKey: string,
  body: Record<string, unknown>,
) {
  const retryDelays = [800];
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });

      if (response.ok || response.status < 500 || attempt >= retryDelays.length) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt >= retryDelays.length) {
        throw error;
      }
    }

    await wait(retryDelays[attempt]);
  }

  throw lastError;
}

export async function POST(request: NextRequest) {
  const key = getClientKey(request);
  const rate = checkRateLimit(key);

  if (!rate.allowed) {
    const isWindowLimit = rate.reason === "window";
    return NextResponse.json(
      {
        error: isWindowLimit
          ? `问礼太急，请约 ${Math.ceil(rate.retryAfterSeconds / 60)} 分钟后再来。`
          : "今日问礼已满，请明日再来。",
        remaining: rate.remaining,
        windowRemaining: rate.windowRemaining,
        dailyRemaining: rate.dailyRemaining,
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  let body: {
    text?: unknown;
    mode?: unknown;
    level?: unknown;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "来意未明，请重新输入。" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const mode = VALID_MODES.has(body.mode as ZhouliMode)
    ? (body.mode as ZhouliMode)
    : "gentle";
  const level = VALID_LEVELS.has(body.level as ZhouliLevel)
    ? (body.level as ZhouliLevel)
    : "standard";

  if (!text) {
    return NextResponse.json({ error: "无言不可成礼，请先写下一句话。" }, { status: 400 });
  }

  if (text.length > 300) {
    return NextResponse.json(
      { error: "言多则礼繁，请将原话控制在300字以内。" },
      { status: 400 },
    );
  }

  if (isDirectedSecondPersonAttackInput(text)) {
    return NextResponse.json({
      result: directedAttackFallback(text, level),
      model: "礼官校订",
      demo: false,
      guarded: true,
      remaining: rate.remaining,
      windowRemaining: rate.windowRemaining,
      dailyRemaining: rate.dailyRemaining,
      retryAfterSeconds: rate.retryAfterSeconds,
    });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    return NextResponse.json({
      result: demoResult(text, mode, level),
      model: "本地演示",
      demo: true,
      remaining: rate.remaining,
      windowRemaining: rate.windowRemaining,
      dailyRemaining: rate.dailyRemaining,
      retryAfterSeconds: rate.retryAfterSeconds,
    });
  }

  try {
    const response = await fetchDeepSeekWithRetry(apiKey, {
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(text, mode, level) },
      ],
      max_tokens: Number(process.env.MAX_OUTPUT_TOKENS || 720),
      temperature: 0.9,
      stream: false,
      thinking: { type: "disabled" },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("DeepSeek API error:", data);
      return NextResponse.json(
        { error: "大儒暂未回应，请稍后再试。" },
        { status: 502 },
      );
    }

    const cleanedResult = cleanGeneratedText(
      data?.choices?.[0]?.message?.content?.trim() || "",
    );
    const result = normalizeFirstPersonWorkResult(
      text,
      normalizeDirectedAttackResult(text, cleanedResult, level),
      level,
    );

    if (!result) {
      return NextResponse.json(
        { error: "此言尚未成礼，请再试一次。" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      result,
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      demo: false,
      usage: data.usage,
      remaining: rate.remaining,
      windowRemaining: rate.windowRemaining,
      dailyRemaining: rate.dailyRemaining,
      retryAfterSeconds: rate.retryAfterSeconds,
    });
  } catch (error) {
    console.error("Translate request failed:", error);
    return NextResponse.json(
      { error: "礼官远行未归，请稍后再试。" },
      { status: 502 },
    );
  }
}
