import {
    Generate,
    chat,
    extension_prompt_roles,
    extension_prompt_types,
    saveMetadata,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE = 'st-turn-director';
const PROMPT_KEY = 'turn_director_current';
const META_KEY = 'turnDirector';
const SETTINGS_URL = new URL('settings.html', import.meta.url).href;
const HARD_RETRY_CAP = 12;
let eventSource;
let event_types;
let SlashCommandParser;
let ConnectionManagerRequestService;

const defaults = {
    masterEnabled: true,
    additionalCharacters: true,
    strategyEnabled: false,
    majorEnabled: false,
    majorChance: 18,
    minorEnabled: false,
    minorChance: 50,
    minorCooldown: 2,
    validationMode: 'off',
    validationProfile: '',
    validationMaxTokens: 4096,
    retryMode: 'none',
    retryMax: 1,
    toasts: true,
    applyOnContinue: false,
    injectionMode: 'macro',
    panelWidth: 0,
    panelHeight: 0,
};

const runtime = {
    turnKey: '',
    directive: null,
    validating: false,
    retrying: false,
    retries: 0,
    lastValidation: null,
    lastGenerationType: '',
};

const strategies = [
    ...Array(6).fill(['직접적인 진실', 'answer with direct truth']),
    ...Array(2).fill(['선택적 진실', 'answer truthfully but select what to reveal']),
    ['일부 진실·중요 사실 누락', 'give partial truth while deliberately omitting an important fact'],
    ['회피·주의 돌리기', 'evade the answer or redirect attention'],
    ['거짓말', 'give a deliberate false answer'],
    ['적극적 기만', 'actively deceive through a coordinated false answer and behavior'],
];
const eventDomains = [
    ['관계·헌신', 'affection, commitment, separation, or changed closeness'],
    ['개인적 선택·깜짝 행동', 'a gift, invitation, preparation, visit, prank, gesture, or unexpected personal choice'],
    ['몸·건강·생애 단계', 'health, injury, recovery, pregnancy-related development, birth, aging, or care needs'],
    ['가족·가정', 'family news, household change, caregiving, living arrangements, or domestic obligations'],
    ['신뢰·비밀·갈등', 'disclosure, deception, discovery, misunderstanding, betrayal, confrontation, or changed trust'],
    ['만남·재회·이별', 'a new acquaintance, reunion, chance meeting, arrival, farewell, absence, or renewed contact'],
    ['일·의무·지위', 'work, duties, institutions, achievement, setback, status, or reputation'],
    ['돈·소유·기회', 'money, possessions, loss, gain, expense, offer, or material access'],
    ['환경·이동·공공 사건', 'environment, travel, disruption, accident, crime, or a public incident'],
    ['세계관 고유 사건', 'the setting’s cultures, factions, systems, beings, history, technology, or magic'],
];
const fortunes = [
    ['매우 불리', 'strongly adverse'], ['불리', 'adverse'], ['약간 불리', 'mildly adverse'], ['혼합·중립', 'mixed or neutral'], ['약간 유리', 'mildly favorable'], ['유리', 'favorable'], ['매우 유리', 'strongly favorable'],
];

function settings() {
    extension_settings[MODULE] ||= {};
    for (const [key, value] of Object.entries(defaults)) {
        if (extension_settings[MODULE][key] === undefined) extension_settings[MODULE][key] = value;
    }
    return extension_settings[MODULE];
}

function state() {
    const metadata = SillyTavern.getContext().chatMetadata;
    if (!metadata) return {
        major: { status: 'idle', id: '', domain: '', fortune: '', startedAt: 0, turns: 0 },
        minor: { status: 'idle', id: '', domain: '', fortune: '', cooldown: 0 },
        recentMinorDomains: [], lastDecision: null, lastValidation: null,
    };
    metadata[META_KEY] ||= {
        major: { status: 'idle', id: '', domain: '', fortune: '', startedAt: 0, turns: 0 },
        minor: { status: 'idle', id: '', domain: '', fortune: '', cooldown: 0 },
        recentMinorDomains: [],
        lastDecision: null,
        lastValidation: null,
    };
    const value = metadata[META_KEY];
    value.major ||= { status: 'idle', id: '', domain: '', fortune: '', startedAt: 0, turns: 0 };
    value.minor ||= { status: 'idle', id: '', domain: '', fortune: '', cooldown: 0 };
    value.recentMinorDomains = Array.isArray(value.recentMinorDomains) ? value.recentMinorDomains.slice(0, 3) : [];
    if (value.lastDecision === undefined) value.lastDecision = null;
    if (value.lastValidation === undefined) value.lastValidation = null;
    return value;
}

function compactDecision(result) {
    if (!result) return null;
    const compactEvent = event => event ? {
        action: event.action,
        domain: event.domain,
        fortune: event.fortune,
    } : null;
    return {
        displayOnly: true,
        createdAt: Number(result.createdAt || Date.now()),
        strategyRows: (result.strategyRows || []).map(row => ({ label: row.label, ko: row.ko })),
        events: {
            major: compactEvent(result.events?.major),
            minor: compactEvent(result.events?.minor),
        },
    };
}

function compactValidation(result) {
    if (!result) return null;
    return {
        overall: result.overall,
        summaryKo: result.summaryKo || '',
        reasonsKo: Array.isArray(result.reasonsKo) ? result.reasonsKo.slice(0, 8) : [],
        at: Number(result.at || Date.now()),
    };
}

function restoreChatSnapshot() {
    const st = state();
    runtime.directive = st.lastDecision || null;
    runtime.lastValidation = st.lastValidation || null;
}

const d = n => Math.floor(Math.random() * n);
const pick = array => array[d(array.length)];
const chance = percent => Math.random() * 100 < Number(percent || 0);
const esc = value => $('<div>').text(String(value ?? '')).html();
const nowId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const CONTINUATION_MARKER = '[NO NEW USER MESSAGE — CONTINUE THE EXISTING IC SCENE]';

function continuationContext(endIndex = chat.length) {
    const recent = chat
        .slice(0, endIndex)
        .filter(message => !message?.is_system && String(message?.mes || '').trim())
        .slice(-3)
        .map(message => `${message.is_user ? 'USER' : 'ASSISTANT'}: ${String(message.mes).trim()}`)
        .join('\n\n');
    return `${CONTINUATION_MARKER}\n${recent.slice(-4000)}`;
}

function latestUserText(type) {
    if (!['regenerate', 'swipe', 'continue'].includes(type)) {
        const pending = String($('#send_textarea').val() || '').trim();
        if (pending) return pending;
        return continuationContext();
    }
    if (type === 'continue') return continuationContext();
    return [...chat].reverse().find(m => m?.is_user && !m?.is_system)?.mes?.trim() || continuationContext();
}

function isOoc(text) {
    const directMatch = /^\s*(?:\(ooc\s*:|!?(?:ooc|오너)(?:\s*:|\s+|$))/i.test(String(text || ''));
    const stored = String(SillyTavern.getContext().chatMetadata?.variables?.cot_ooc_input ?? '').trim().toLowerCase();
    const storedMatch = !['', '[]', '0', 'false', 'null', 'undefined'].includes(stored);
    return directMatch || storedMatch;
}

function makeStrategy(label) {
    const value = pick(strategies);
    return { label, ko: value[0], text: value[1] };
}

function rollEvents(turnIndex) {
    const s = settings();
    const st = state();
    const result = { major: null, minor: null };

    if (st.major.status === 'active') {
        st.major.turns = Number(st.major.turns || 0) + 1;
        const laneRoll = d(100) + 1;
        result.major = { action: laneRoll <= 35 ? 'surface' : 'background', ...st.major };
    } else if (s.majorEnabled && chance(s.majorChance)) {
        const domain = pick(eventDomains);
        const fortune = pick(fortunes);
        st.major = { status: 'active', id: nowId('major'), domain: domain[0], domainText: domain[1], fortune: fortune[0], fortuneText: fortune[1], startedAt: turnIndex, turns: 0 };
        result.major = { action: 'start', ...st.major };
    }

    if (st.minor.cooldown > 0) st.minor.cooldown -= 1;
    if (st.minor.status === 'active') {
        result.minor = { action: 'continue', ...st.minor };
        st.minor.status = 'idle';
        st.minor.cooldown = Number(s.minorCooldown || 0);
    } else if (s.minorEnabled && st.minor.cooldown <= 0 && chance(s.minorChance)) {
        const recent = new Set(st.recentMinorDomains || []);
        const pool = eventDomains.filter(x => !recent.has(x[0]));
        const domain = pick(pool.length ? pool : eventDomains);
        const fortune = pick(fortunes);
        st.minor = { status: 'active', id: nowId('minor'), domain: domain[0], domainText: domain[1], fortune: fortune[0], fortuneText: fortune[1], cooldown: 0 };
        st.recentMinorDomains = [domain[0], ...(st.recentMinorDomains || []).filter(x => x !== domain[0])].slice(0, 3);
        result.minor = { action: 'start', ...st.minor };
    }
    return result;
}

function activeCharacterName() {
    const context = SillyTavern.getContext();
    const character = context?.characters?.[context?.characterId];
    const raw = context?.name2 || character?.name || 'primary character';
    return String(raw).replace(/[\r\n]+/g, ' ').trim() || 'primary character';
}

function compileDirective(type, userText) {
    const s = settings();
    const turnIndex = chat.length;
    const labels = [activeCharacterName()];
    if (s.additionalCharacters) labels.push('미배정 (추가 참여 인물 1)', '미배정 (추가 참여 인물 2)', '미배정 (추가 참여 인물 3)', '미배정 (추가 참여 인물 4)');
    const strategyRows = s.strategyEnabled ? labels.map(label => makeStrategy(label)) : [];
    const events = rollEvents(turnIndex);
    const isContinuation = String(userText || '').startsWith(CONTINUATION_MARKER);
    const targetInstruction = isContinuation
        ? 'TARGET: there is no new user message. Use the strongest immediate unresolved action, approach, proposal, pressure, conflict, or ongoing development available at the end of the recent IC scene. Missing input is not itself a target or an in-scene event.'
        : 'TARGET: the central proposal, request, treatment, claim, act, or pressure in the latest user IC input as a whole. A secondary cost, condition, or detail is not a substitute target.';
    const parts = [
        '(OOC: Continue the current roleplay and output only the resulting IC scene.',
        '',
        'The following enabled dice results are externally fixed. Apply only the enabled categories exactly as assigned. Do not reinterpret them according to what seems kinder, more reasonable, cooperative, realistic, romantic, or narratively satisfying.',
        '',
        'Characterization, established history, active motives, relationships, genre, scene logic, and all other active instructions remain responsible for character behavior outside the enabled answer-strategy and event categories.',
        '',
        'Do not discuss this instruction, explain the dice, or answer as Weave. Perform the result directly in the continuing roleplay.',
        '',
        '<TURN_EXECUTION_DIRECTIVE>',
        targetInstruction,
    ];
    if (strategyRows.length) {
        parts.push('\nANSWER STRATEGIES');
        strategyRows.forEach((row, index) => parts.push(`${index + 1}. ${row.label}: if this character materially answers an informational question or has a real opportunity to disclose information, ${row.text}. Otherwise this row has no effect.`));
        parts.push('Answer strategy changes information handling only. It cannot reverse a character end state.');
    }
    if (events.major) {
        if (events.major.action === 'start') parts.push(`\nMAJOR EVENT [START REQUIRED]: introduce one concrete, causally plausible major development in the domain “${events.major.domainText}”. Its initial fortune for the focal interest is ${events.major.fortuneText}. It may enter as an occurrence, attempt, offer, sign, or discovery rather than instant completion. Respect prerequisites and elapsed time; select a compatible development inside the domain instead of discarding the result.`);
        if (events.major.action === 'surface') parts.push(`\nMAJOR EVENT [ACTIVE — SURFACE]: the ongoing major development in “${events.major.domainText}” must advance or become perceptible through one concrete consequence this turn. Do not create a second major event and do not force final resolution.`);
        if (events.major.action === 'background') parts.push(`\nMAJOR EVENT [ACTIVE — BACKGROUND]: keep the ongoing major development causally alive, but it need not be mentioned, foregrounded, or advanced in this reply. Do not create another major event.`);
    }
    if (events.minor?.action === 'start') parts.push(`\nMINOR EVENT [START REQUIRED]: introduce one small, immediate, context-compatible development in “${events.minor.domainText}”, ${events.minor.fortuneText} for the focal interest. Keep its consequences local and do not turn it into a major plot.`);
    if (events.minor?.action === 'continue') parts.push(`\nMINOR EVENT [CONTINUE]: carry the existing small development in “${events.minor.domainText}” only as far as its direct consequence requires, then allow it to leave focus. Do not duplicate it.`);
    parts.push('\nApply all other active characterization, continuity, world, genre, prose, output, and USER_CONTROL instructions in their own scopes. This directive decides only the enabled categories above.', '</TURN_EXECUTION_DIRECTIVE>', ')');
    return { type, userText, strategyRows, events, prompt: parts.join('\n'), createdAt: Date.now() };
}

function macroValue() {
    if (!settings().masterEnabled || settings().injectionMode !== 'macro' || !runtime.directive?.prompt) return '';
    return runtime.directive.prompt;
}

async function prepareGeneration(type, _options, dryRun) {
    if (dryRun || type === 'quiet' || type === 'impersonate') return;
    const s = settings();
    if (!s.masterEnabled) {
        runtime.directive = null;
        runtime.lastValidation = null;
        runtime.retrying = false;
        runtime.retries = 0;
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    const text = latestUserText(type);
    runtime.lastGenerationType = type || 'normal';
    if (isOoc(text)) {
        runtime.directive = null;
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        if (s.toasts) toastr.info('OOC 감지 — 주사위·사건·판독을 건너뜁니다.', '💬 굴려굴려', { timeOut: 1800, preventDuplicates: true });
        return;
    }
   
    const key = `${type === 'regenerate' && runtime.retrying ? 'retry' : type}|${chat.length}|${text}`;
    if (!(runtime.retrying && runtime.directive) && (runtime.turnKey !== key || !runtime.directive)) {
        runtime.turnKey = key;
        runtime.retries = 0;
        runtime.lastValidation = null;
        runtime.directive = compileDirective(type, text);
        const st = state();
        st.lastDecision = compactDecision(runtime.directive);
        st.lastValidation = null;
        // Persist only the compact latest result and event state without delaying the RP request itself.
        void saveMetadata().catch(error => console.warn('[Turn Director] Event state save failed', error));
        if (s.toasts) showRollToast(runtime.directive);
    }
    if (s.injectionMode === 'depth0') {
        setExtensionPrompt(PROMPT_KEY, runtime.directive?.prompt || '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    } else {
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
    }
    refreshUi();
}

function showRollToast(result) {
    const bits = [];
    if (result.strategyRows.length) bits.push('답변 전략');
    if (result.events.major?.action === 'start') bits.push('대형 사건 발생');
    if (result.events.minor?.action === 'start') bits.push('소형 사건 발생');
    if (!bits.length) bits.push('추가 판정 없음');
    toastr.info(bits.join(' · '), '🎲 굴려굴려', { timeOut: 1800, preventDuplicates: true });
}

function buildValidatorPrompt(assistantText, directive = runtime.directive) {
    const r = directive;
    return [
        { role: 'system', content: `You are a strict compliance judge. Compare only the externally fixed directive with the functional outcome of the assistant IC response. The directive is final and cannot be reinterpreted through characterization, realism, sympathy, warmth, compromise, or narrative preference. Judge what the response actually does, not stated intentions. Do not require a separate latest-user-input field and never fail merely because no new user message exists; for a continuation, identify the active TARGET from the directive and the ongoing interaction visible in the response. Evaluate only enabled categories. Return only valid JSON with this schema: {"overall":"PASS|FAIL","strategy":"PASS|FAIL|NA","major":"PASS|FAIL|NA","minor":"PASS|FAIL|NA","majorStatus":"KEEP|RESOLVED|NA","reasonsKo":["short Korean reason"],"summaryKo":"detailed but concise Korean explanation"}. Do not judge prose quality.` },
        { role: 'user', content: `EXTERNAL DIRECTIVE:\n${r.prompt}\n\nASSISTANT IC RESPONSE:\n${assistantText}` },
    ];
}

function latestAssistantExchange() {
    for (let assistantIndex = chat.length - 1; assistantIndex >= 0; assistantIndex--) {
        const assistant = chat[assistantIndex];
        if (assistant?.is_user || assistant?.is_system || !String(assistant?.mes || '').trim()) continue;
        let userText = '';
        for (let userIndex = assistantIndex - 1; userIndex >= 0; userIndex--) {
            const message = chat[userIndex];
            if (message?.is_user && !message?.is_system) {
                userText = String(message?.mes || '').trim();
                break;
            }
        }
        return { assistant, userText: userText || continuationContext(assistantIndex) };
    }
    return null;
}

function restoreValidationDirective(saved, userText) {
    const lines = [
        'RESTORED EXTERNAL DIRECTIVE FOR THE LATEST ASSISTANT IC RESPONSE.',
        'Judge the saved outcomes exactly. Characterization or narrative preference cannot alter them.',
    ];
    for (const row of saved.strategyRows || []) {
        lines.push(`ANSWER STRATEGY: ${row.label}: ${row.ko || 'NA'}.`);
    }
    for (const [size, event] of Object.entries(saved.events || {})) {
        if (event) lines.push(`${size.toUpperCase()} EVENT: action=${event.action || 'NA'}; domain=${event.domain || 'NA'}; fortune=${event.fortune || 'NA'}.`);
    }
    return { ...saved, displayOnly: false, restored: true, userText, prompt: lines.join('\n') };
}

function extractValidatorText(raw, depth = 0) {
    if (raw == null || depth > 6) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    if (Array.isArray(raw)) {
        return raw.map(item => extractValidatorText(item, depth + 1)).filter(Boolean).join('\n');
    }
    if (typeof raw !== 'object') return '';

    if (raw.overall) return JSON.stringify(raw);

    const preferred = [
        raw.content,
        raw.text,
        raw.response,
        raw.output_text,
        raw.message?.content,
        raw.choices?.[0]?.message?.content,
        raw.choices?.[0]?.text,
        raw.candidates?.[0]?.content?.parts,
        raw.candidates?.[0]?.output,
        raw.data?.content,
        raw.data?.text,
        raw.result?.content,
        raw.result?.text,
    ];

    for (const value of preferred) {
        const text = extractValidatorText(value, depth + 1).trim();
        if (text) return text;
    }

    return '';
}

function findJsonObjects(text) {
    const objects = [];
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') {
            quoted = true;
        } else if (char === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (char === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                objects.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return objects;
}

function parseJudge(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.overall) {
        raw.overall = String(raw.overall || '').toUpperCase();
        if (!['PASS', 'FAIL'].includes(raw.overall)) throw new Error('PASS/FAIL 값을 판독할 수 없습니다.');
        return raw;
    }

    const text = extractValidatorText(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!text) throw new Error('판독 모델의 응답 본문이 비어 있습니다. 연결 프로필과 모델을 확인해 주세요.');

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        for (const candidate of findJsonObjects(text)) {
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object' && parsed.overall) {
                    data = parsed;
                    break;
                }
            } catch {
                // Try the next complete JSON object.
            }
        }
    }

    if (!data) {
        throw new Error('판독 응답이 JSON 완성 전에 잘렸습니다. 판독 모델의 출력 한도를 확인해 주세요.');
    }
    data.overall = String(data.overall || '').toUpperCase();
    if (!['PASS', 'FAIL'].includes(data.overall)) throw new Error('PASS/FAIL 값을 판독할 수 없습니다.');
    return data;
}

async function validateLatest({ manual = false } = {}) {
    const s = settings();
    if (!s.masterEnabled) throw new Error('굴려굴려가 OFF 상태입니다.');
    const sourceMetadata = SillyTavern.getContext().chatMetadata;
    if (!runtime.directive) throw new Error('현재 턴에 저장된 판정이 없습니다.');
    if (!s.validationProfile) throw new Error('판독용 연결 프로필을 먼저 선택하세요.');
    if (!ConnectionManagerRequestService) throw new Error('이 SillyTavern 버전에서는 Connection Profile 판독 API를 사용할 수 없습니다.');
    const exchange = latestAssistantExchange();
    if (!exchange) throw new Error('판독할 최신 IC 답변이 없습니다.');
    const directive = runtime.directive.displayOnly
        ? restoreValidationDirective(runtime.directive, exchange.userText)
        : runtime.directive;
    if (runtime.validating) return runtime.lastValidation;
    runtime.validating = true;
    try {
        const response = await ConnectionManagerRequestService.sendRequest(
            s.validationProfile,
            buildValidatorPrompt(exchange.assistant.mes, directive),
            Math.min(32768, Math.max(512, Number(s.validationMaxTokens) || 4096)),
            { stream: false, extractData: true, includePreset: false, includeInstruct: false },
            { temperature: 0, top_p: 0.1, reasoning_effort: 'low', include_reasoning: false },
        );
        if (SillyTavern.getContext().chatMetadata !== sourceMetadata) {
            throw new Error('판독 중 채팅방이 변경되어 이전 판독 결과를 폐기했습니다.');
        }
        runtime.lastValidation = { ...parseJudge(response), at: Date.now(), manual };
        state().lastValidation = compactValidation(runtime.lastValidation);
        if (runtime.lastValidation.majorStatus === 'RESOLVED' && state().major.status === 'active') {
            state().major.status = 'idle';
        }
        await saveMetadata();
        refreshUi();
        return runtime.lastValidation;
    } finally {
        runtime.validating = false;
    }
}

function retryLimit() {
    const s = settings();
    if (s.retryMode === 'none') return 0;
    if (s.retryMode === 'fixed') return Math.min(HARD_RETRY_CAP, Math.max(1, Number(s.retryMax || 1)));
    return HARD_RETRY_CAP;
}

async function onMessageReceived(_messageId, type) {
    const s = settings();
    if (!s.masterEnabled || s.validationMode !== 'auto' || !runtime.directive || runtime.validating) return;
    if (type === 'quiet' || isOoc(runtime.directive.userText)) return;
    const sourceContext = SillyTavern.getContext();
    const sourceMetadata = sourceContext.chatMetadata;
    const sourceLength = sourceContext.chat?.length ?? chat.length;
    const sourceDirective = runtime.directive;
    try {
        const verdict = await validateLatest();
        const currentContext = SillyTavern.getContext();
        if (currentContext.chatMetadata !== sourceMetadata || (currentContext.chat?.length ?? chat.length) !== sourceLength || runtime.directive !== sourceDirective) {
            runtime.retrying = false;
            return;
        }
        if (verdict.overall === 'PASS') {
            runtime.retrying = false;
            runtime.retries = 0;
            toastr.success('방향·사건 판정 통과', '✅ 굴려굴려');
            return;
        }
        const limit = retryLimit();
        if (runtime.retries >= limit) {
            runtime.retrying = false;
            toastr.error(`판정 실패 · 재생성 ${runtime.retries}/${limit}`, '❌ 굴려굴려', { timeOut: 5000 });
            return;
        }
        runtime.retries += 1;
        runtime.retrying = true;
        toastr.warning(`판정 실패 · 기존 답변을 보존하고 새 스와이프 생성 ${runtime.retries}/${limit}`, '⚠️ 굴려굴려');
        setTimeout(() => {
            const context = SillyTavern.getContext();
            if (context.chatMetadata !== sourceMetadata || (context.chat?.length ?? chat.length) !== sourceLength || runtime.directive !== sourceDirective) {
                runtime.retrying = false;
                return;
            }
            Generate('swipe').catch(error => { runtime.retrying = false; handleError(error, '스와이프 재생성 실패'); });
        }, 80);
    } catch (error) {
        runtime.retrying = false;
        handleError(error, '판독 실패');
    }
}

function categoryStatus() {
    const s = settings();
    return [
        `전체 ${s.masterEnabled ? 'ON' : 'OFF'}`,
        `답변전략 ${s.strategyEnabled ? 'ON' : 'OFF'}`,
        `대형 ${s.majorEnabled ? `${s.majorChance}%` : 'OFF'}`,
        `소형 ${s.minorEnabled ? `${s.minorChance}%` : 'OFF'}`,
        `판독 ${s.validationMode === 'auto' ? '자동' : s.validationMode === 'manual' ? '수동' : 'OFF'}`,
    ].join(' / ');
}

function statusHtml() {
    const r = runtime.directive;
    const v = runtime.lastValidation;
    if (!r) return '<div class="td-status-section"><h3>아직 판정 없음</h3><p class="td-muted">IC 답변을 한 번 생성하면 이곳에 현재 턴의 해석이 표시됩니다.</p></div>';
    const strategy = (r.strategyRows || []).map(x => `<p><b>${esc(x.label)}</b> — ${esc(x.ko)}</p>`).join('') || '<p class="td-muted">사용 안 함</p>';
    const events = [r.events?.major ? `대형: ${r.events.major.action === 'start' ? '새로 발생' : r.events.major.action === 'surface' ? '이번 턴 진행' : '배경에서 유지'} · ${r.events.major.domain} · ${r.events.major.fortune}` : '대형: 없음', r.events?.minor ? `소형: ${r.events.minor.action === 'start' ? '새로 발생' : '직접 결과 진행'} · ${r.events.minor.domain} · ${r.events.minor.fortune}` : '소형: 없음'].map(x => `<p>${esc(x)}</p>`).join('');
    const validation = v ? `<p><b>${v.overall === 'PASS' ? '✅ 통과' : '❌ 실패'}</b></p><p>${esc(v.summaryKo || '')}</p>${(v.reasonsKo || []).map(x => `<p>• ${esc(x)}</p>`).join('')}<p class="td-muted">재생성 사용: ${runtime.retries}회</p>` : '<p class="td-muted">아직 판독하지 않았습니다.</p>';
    return `<div class="td-status-section"><h3>🗣️ 답변 전략</h3>${strategy}</div><div class="td-status-section"><h3>🎬 사건</h3>${events}</div><div class="td-status-section"><h3>🔎 답변 검증</h3>${validation}</div>`;
}

function eventHtml() {
    const st = state();
    const major = st.major.status === 'active' ? `<b>진행 중</b><br>${esc(st.major.domain)} · 최초 운: ${esc(st.major.fortune)} · 경과 ${Number(st.major.turns || 0)}턴` : '<b>대기</b> — 진행 중인 대형 사건 없음';
    const minor = st.minor.status === 'active' ? `<b>직접 결과 대기</b><br>${esc(st.minor.domain)} · ${esc(st.minor.fortune)}` : `<b>대기</b> · 쿨다운 ${Number(st.minor.cooldown || 0)}턴`;
    return `<div class="td-status-section"><h3>🎬 대형 사건</h3><p>${major}</p></div><div class="td-status-section"><h3>✨ 소형 사건</h3><p>${minor}</p><p class="td-muted">최근 영역: ${esc((st.recentMinorDomains || []).join(', ') || '없음')}</p></div>`;
}

function refreshUi() {
    const s = settings();
    $('#td_settings_summary').text(categoryStatus());
    $('#td_status_content').html(statusHtml());
    $('#td_event_content').html(eventHtml());
    $('#td_profile_badge').text(s.validationProfile ? '별도 프로필 사용' : '프로필 미선택');
    refreshQuickPanel();
}

function quickPanelHtml() {
    return `<aside id="td_quick_popover" popover="manual" hidden aria-label="굴려굴려 빠른 제어">
        <div class="td-quick-head">
            <div><div class="td-quick-title">🎲 굴려굴려</div><div id="td_quick_summary" class="td-quick-summary"></div></div>
            <button type="button" id="td_quick_close" class="td-quick-close" aria-label="닫기">×</button>
        </div>
        <div class="td-quick-toggles">
            <label class="td-quick-toggle"><input type="checkbox" data-td-master><span>전체 작동</span></label>
            <label class="td-quick-toggle"><input type="checkbox" data-td-quick="strategyEnabled"><span>답변 전략</span></label>
            <label class="td-quick-toggle"><input type="checkbox" data-td-quick="majorEnabled"><span>대형 사건</span></label>
            <label class="td-quick-toggle"><input type="checkbox" data-td-quick="minorEnabled"><span>소형 사건</span></label>
        </div>
        <div class="td-quick-actions">
            <button type="button" id="td_quick_status" class="menu_button">판정 보기</button>
            <button type="button" id="td_quick_validate" class="menu_button">수동 판독</button>
            <button type="button" id="td_quick_settings" class="menu_button">설정</button>
            <button type="button" id="td_quick_major_done" class="menu_button">대형 완료</button>
            <button type="button" id="td_quick_minor_done" class="menu_button">소형 완료</button>
        </div>
    </aside>`;
}

function refreshQuickPanel() {
    if (!$('#td_quick_popover').length) return;
    const s = settings();
    const st = state();
    $('[data-td-master]').prop('checked', Boolean(s.masterEnabled));
    $('[data-td-quick]').each(function () {
        const key = $(this).attr('data-td-quick');
        $(this).prop('checked', Boolean(s[key]));
    });
    const validation = s.validationMode === 'auto' ? '자동 판독' : s.validationMode === 'manual' ? '수동 판독' : '판독 OFF';
    $('#td_quick_summary').text(`${s.masterEnabled ? '전체 ON' : '전체 OFF'} · ${validation} · 대형 ${st.major.status === 'active' ? '진행 중' : '대기'} · 소형 ${st.minor.status === 'active' ? '진행 중' : '대기'}`);
    $('#td_quick_major_done').prop('disabled', st.major.status !== 'active');
    $('#td_quick_minor_done').prop('disabled', st.minor.status !== 'active');
}

function hideQuickPanel() {
    const element = document.getElementById('td_quick_popover');
    if (!element) return;
    try {
        if (typeof element.hidePopover === 'function' && element.matches(':popover-open')) element.hidePopover();
    } catch { /* Fall back to the hidden attribute. */ }
    element.hidden = true;
}

function toggleQuickPanel() {
    const panel = $('#td_quick_popover');
    const opening = panel.prop('hidden');
    if (opening) {
        refreshQuickPanel();
        panel.prop('hidden', false).css({ visibility: 'hidden' });
        const element = panel[0];
        try {
            if (typeof element?.showPopover === 'function' && !element.matches(':popover-open')) element.showPopover();
        } catch { /* Fixed-position fallback remains visible. */ }
        const anchor = document.getElementById('td_floating_button');
        if (anchor) {
            const rect = anchor.getBoundingClientRect();
            const viewport = window.visualViewport;
            const viewportLeft = viewport?.offsetLeft || 0;
            const viewportTop = viewport?.offsetTop || 0;
            const viewportWidth = viewport?.width || window.innerWidth;
            const viewportHeight = viewport?.height || window.innerHeight;
            const gap = 7;
            const width = Math.max(240, Math.min(330, viewportWidth - gap * 2));
            panel.css({ width: `${width}px`, maxHeight: `${Math.max(180, viewportHeight - gap * 2)}px`, overflowY: 'auto' });
            const height = Math.min(panel.outerHeight() || 0, viewportHeight - gap * 2);
            const minLeft = viewportLeft + gap;
            const maxLeft = viewportLeft + viewportWidth - width - gap;
            const left = Math.max(minLeft, Math.min(rect.right - width, maxLeft));
            let top = rect.top - height - gap;
            if (top < viewportTop + gap) top = rect.bottom + gap;
            top = Math.max(viewportTop + gap, Math.min(top, viewportTop + viewportHeight - height - gap));
            panel.css({ left: `${left}px`, right: 'auto', top: `${top}px`, bottom: 'auto' });
        }
        panel.css({ visibility: 'visible' });
        return;
    }
    hideQuickPanel();
}

function applyPanelSize() {
    const panel = $('#td_overlay .td-panel');
    if (!panel.length) return;
    const s = settings();
    const viewport = window.visualViewport;
    const availableWidth = Math.max(280, (viewport?.width || window.innerWidth) - 16);
    const availableHeight = Math.max(280, (viewport?.height || window.innerHeight) - 16);
    const width = Number(s.panelWidth || 0);
    const height = Number(s.panelHeight || 0);
    panel.css({
        width: width > 0 ? `${Math.min(availableWidth, Math.max(280, width))}px` : '',
        height: height > 0 ? `${Math.min(availableHeight, Math.max(280, height))}px` : '',
    });
}

function bindPanelResize() {
    const handle = document.getElementById('td_resize_handle');
    const panel = document.querySelector('#td_overlay .td-panel');
    if (!handle || !panel) return;
    handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        const rect = panel.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        handle.setPointerCapture?.(event.pointerId);
        panel.classList.add('td-resizing');
        const move = moveEvent => {
            const viewport = window.visualViewport;
            const maxWidth = Math.max(280, (viewport?.width || window.innerWidth) - 16);
            const maxHeight = Math.max(280, (viewport?.height || window.innerHeight) - 16);
            const width = Math.min(maxWidth, Math.max(280, rect.width + moveEvent.clientX - startX));
            const height = Math.min(maxHeight, Math.max(280, rect.height + moveEvent.clientY - startY));
            panel.style.width = `${width}px`;
            panel.style.height = `${height}px`;
        };
        const end = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
            panel.classList.remove('td-resizing');
            settings().panelWidth = Math.round(panel.getBoundingClientRect().width);
            settings().panelHeight = Math.round(panel.getBoundingClientRect().height);
            saveSettingsDebounced();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('dblclick', () => {
        settings().panelWidth = 0;
        settings().panelHeight = 0;
        panel.style.width = '';
        panel.style.height = '';
        saveSettingsDebounced();
    });
}

function syncInputs() {
    const s = settings();
    $('#td_strategy_enabled').prop('checked', s.strategyEnabled);
    $('#td_major_enabled').prop('checked', s.majorEnabled);
    $('#td_major_chance').val(s.majorChance); $('#td_major_chance_out').text(`${s.majorChance}%`);
    $('#td_minor_enabled').prop('checked', s.minorEnabled);
    $('#td_minor_chance').val(s.minorChance); $('#td_minor_chance_out').text(`${s.minorChance}%`);
    $('#td_minor_cooldown').val(s.minorCooldown);
    $('#td_validation_mode').val(s.validationMode);
    $('#td_settings_validation_profile').val(s.validationProfile);
    $('#td_validation_max_tokens').val(s.validationMaxTokens);
    $('#td_retry_mode').val(s.retryMode);
    $('#td_retry_max').val(s.retryMax);
    $('#td_toasts').prop('checked', s.toasts);
    $('#td_injection_mode').val(s.injectionMode);
    updateDisabledStates();
    refreshUi();
}

function updateDisabledStates() {
    const s = settings();
    $('#td_major_chance').prop('disabled', !s.majorEnabled);
    $('#td_minor_chance,#td_minor_cooldown').prop('disabled', !s.minorEnabled);
    $('#td_validation_profile,#td_validation_max_tokens,#td_retry_mode').prop('disabled', s.validationMode === 'off');
    $('#td_retry_max').prop('disabled', s.validationMode === 'off' || s.retryMode !== 'fixed');
}

function saveInput(id, key, transform = value => value) {
    $(id).on('input change', function () {
        const raw = this.type === 'checkbox' ? this.checked : this.value;
        settings()[key] = transform(raw);
        if (id === '#td_major_chance') $('#td_major_chance_out').text(`${raw}%`);
        if (id === '#td_minor_chance') $('#td_minor_chance_out').text(`${raw}%`);
        saveSettingsDebounced();
        updateDisabledStates();
        refreshUi();
    });
}

function showPanel(tab = 'control') {
    hideQuickPanel();
    syncInputs();
    applyPanelSize();
    $('.td-tab').removeClass('is-active').filter(`[data-tab="${tab}"]`).addClass('is-active');
    $('.td-tabpage').removeClass('is-active').filter(`[data-page="${tab}"]`).addClass('is-active');
    const overlay = document.getElementById('td_overlay');
    if (!overlay) return;
    if (overlay.parentElement !== document.body) document.body.appendChild(overlay);
    if (!overlay.open) {
        if (typeof overlay.showModal === 'function') overlay.showModal();
        else overlay.setAttribute('open', '');
    }
}

function hidePanel() {
    const overlay = document.getElementById('td_overlay');
    if (!overlay) return;
    if (overlay.open && typeof overlay.close === 'function') overlay.close();
    else overlay.removeAttribute('open');
}

function fillProfiles() {
    const selects = $('#td_validation_profile,#td_settings_validation_profile');
    selects.empty().append('<option value="">선택 안 함</option>');
    try {
        if (!ConnectionManagerRequestService) throw new Error('Connection Profile API unavailable');
        for (const profile of ConnectionManagerRequestService.getSupportedProfiles()) {
            selects.each(function () {
                $(this).append($('<option>').val(profile.id).text(`${profile.name || profile.id}${profile.model ? ` · ${profile.model}` : ''}`));
            });
        }
    } catch (error) {
        console.warn('[Turn Director] Connection profiles unavailable', error);
    }
    selects.val(settings().validationProfile);
}

async function manualValidate() {
    try {
        toastr.info('저장된 연결 프로필로 판독 중…', '🔎 굴려굴려');
        const result = await validateLatest({ manual: true });
        showPanel('status');
        toastr[result.overall === 'PASS' ? 'success' : 'error'](result.overall === 'PASS' ? '판정 통과' : '판정 실패', '굴려굴려');
    } catch (error) { handleError(error, '수동 판독 실패'); }
}

async function finishEvent(which) {
    state()[which] = which === 'major'
        ? { status: 'idle', id: '', domain: '', fortune: '', startedAt: 0, turns: 0 }
        : { status: 'idle', id: '', domain: '', fortune: '', cooldown: Number(settings().minorCooldown || 0) };
    await saveMetadata();
    refreshUi();
    toastr.success(which === 'major' ? '대형 사건을 완료 처리했습니다.' : '소형 사건을 완료 처리했습니다.', '🎬 굴려굴려');
}

function handleError(error, title = '굴려굴려 오류') {
    console.error('[Turn Director]', error);
    toastr.error(error?.message || String(error), title, { timeOut: 7000 });
}

function registerCommands() {
    if (!SlashCommandParser?.addCommand) {
        console.warn('[Turn Director] Slash commands are unavailable in this SillyTavern version.');
        return;
    }
    SlashCommandParser.addCommand('td-settings', () => { showPanel('control'); return ''; }, ['turn-director'], '굴려굴려 설정을 엽니다.');
    SlashCommandParser.addCommand('td-status', () => { showPanel('status'); return ''; }, [], '현재 주사위 판정을 봅니다.');
    SlashCommandParser.addCommand('td-validate', async () => { await manualValidate(); return ''; }, [], '최신 답변을 수동 판독합니다.');
    SlashCommandParser.addCommand('td-major-done', async () => { await finishEvent('major'); return ''; }, [], '대형 사건을 완료 처리합니다.');
    SlashCommandParser.addCommand('td-minor-done', async () => { await finishEvent('minor'); return ''; }, [], '소형 사건을 완료 처리합니다.');
}

function bindUi() {
    saveInput('#td_strategy_enabled', 'strategyEnabled', Boolean);
    saveInput('#td_major_enabled', 'majorEnabled', Boolean);
    saveInput('#td_major_chance', 'majorChance', Number);
    saveInput('#td_minor_enabled', 'minorEnabled', Boolean);
    saveInput('#td_minor_chance', 'minorChance', Number);
    saveInput('#td_minor_cooldown', 'minorCooldown', Number);
    saveInput('#td_validation_mode', 'validationMode');
    saveInput('#td_validation_profile', 'validationProfile');
    saveInput('#td_settings_validation_profile', 'validationProfile');
    saveInput('#td_validation_max_tokens', 'validationMaxTokens', value => Math.min(32768, Math.max(512, Number(value) || 4096)));
    saveInput('#td_retry_mode', 'retryMode');
    saveInput('#td_retry_max', 'retryMax', Number);
    saveInput('#td_toasts', 'toasts', Boolean);
    saveInput('#td_injection_mode', 'injectionMode');
    $('#td_open_panel').on('click', () => showPanel('control'));
    $('#td_close,#td_save_close').on('click', hidePanel);
    $('#td_overlay').on('click', e => { if (e.target.id === 'td_overlay') hidePanel(); });
    $('.td-tab').on('click', function () { showPanel($(this).data('tab')); });
    $('#td_validate_now,#td_status_validate').on('click', manualValidate);
    $('#td_status_refresh').on('click', refreshUi);
    $('#td_major_done').on('click', () => finishEvent('major'));
    $('#td_minor_done').on('click', () => finishEvent('minor'));
    $('#td_event_reset').on('click', async () => {
        const st = state();
        st.major = { status: 'idle', id: '', domain: '', fortune: '', startedAt: 0, turns: 0 };
        st.minor = { status: 'idle', id: '', domain: '', fortune: '', cooldown: 0 };
        st.recentMinorDomains = [];
        await saveMetadata(); refreshUi(); toastr.success('사건 상태와 중복 기록을 초기화했습니다.', '굴려굴려');
    });
    $(document).off('click.tdQuickButton', '#td_floating_button').on('click.tdQuickButton', '#td_floating_button', e => { e.preventDefault(); e.stopPropagation(); toggleQuickPanel(); });
    $(document).off('keydown.tdQuickButton', '#td_floating_button').on('keydown.tdQuickButton', '#td_floating_button', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleQuickPanel(); } });
    $('#extensionsMenu').off('click.tdWand', '#td_wand_entry').on('click.tdWand', '#td_wand_entry', e => {
        e.preventDefault(); e.stopPropagation(); showPanel('control'); toastr.info('본 설정을 열었습니다.', '🎲 굴려굴려', { timeOut: 1200 });
    });
    $('#td_quick_popover').on('pointerdown click', e => e.stopPropagation());
    $('#td_quick_close').on('click', hideQuickPanel);
    $(document).off('pointerdown.tdQuick').on('pointerdown.tdQuick', e => {
        if (!$(e.target).closest('#td_quick_popover,#td_floating_button,#td_wand_entry').length) hideQuickPanel();
    });
    $('[data-td-master]').on('change', function () {
        const enabled = this.checked;
        settings().masterEnabled = enabled;
        runtime.turnKey = '';
        runtime.directive = null;
        runtime.lastValidation = null;
        runtime.retrying = false;
        runtime.retries = 0;
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        saveSettingsDebounced();
        refreshUi();
        toastr.info(`전체 작동: ${enabled ? 'ON' : 'OFF'}`, '🎲 굴려굴려', { timeOut: 1200, preventDuplicates: true });
    });
    $('[data-td-quick]').on('change', function () {
        const key = $(this).attr('data-td-quick');
        settings()[key] = this.checked;
        saveSettingsDebounced();
        syncInputs();
        const names = { strategyEnabled: '답변 전략', majorEnabled: '대형 사건', minorEnabled: '소형 사건' };
        toastr.info(`${names[key] || key}: ${this.checked ? 'ON' : 'OFF'}`, '🎲 굴려굴려', { timeOut: 1200 });
    });
    $('#td_quick_settings').on('click', () => { showPanel('control'); toastr.info('본 설정을 열었습니다.', '🎲 굴려굴려', { timeOut: 1200 }); });
    $('#td_quick_status').on('click', () => { showPanel('status'); toastr.info('현재 판정을 열었습니다.', '🎲 굴려굴려', { timeOut: 1200 }); });
    $('#td_quick_validate').on('click', () => { hideQuickPanel(); manualValidate(); });
    $('#td_quick_major_done').on('click', () => finishEvent('major'));
    $('#td_quick_minor_done').on('click', () => finishEvent('minor'));
}

jQuery(async () => {
    settings();
    const context = SillyTavern.getContext();
    ({ eventSource, event_types } = context);
    SlashCommandParser = context.SlashCommandParser;
    try {
        ({ ConnectionManagerRequestService } = await import('../../shared.js'));
    } catch (error) {
        console.warn('[Turn Director] Separate validation profiles are unavailable', error);
    }
    const { macros, registerMacro, unregisterMacro } = context;
    try {
        if (macros?.register) {
            try { macros.registry?.unregisterMacro?.('turn_director'); } catch { /* not registered */ }
            macros.register('turn_director', {
                description: '현재 굴려굴려 판정을 프리셋의 정확한 위치에 삽입합니다.',
                handler: macroValue,
            });
        } else {
            try { unregisterMacro?.('turn_director'); } catch { /* not registered */ }
            registerMacro?.('turn_director', macroValue, '현재 굴려굴려 판정을 삽입합니다.');
        }
    } catch (error) {
        handleError(error, '굴려굴려 매크로 등록 실패');
    }
    let html;
    try {
        html = await $.get(SETTINGS_URL);
    } catch (error) {
        handleError(error, '굴려굴려 UI 로드 실패');
        return;
    }
    $('#extensions_settings').append(html);
    $('#td_overlay').appendTo('body');
    if (!$('#td_floating_button').length) {
        const diceButton = $('<div id="td_floating_button" class="interactable" role="button" tabindex="0" title="굴려굴려 빠른 제어" aria-label="굴려굴려 빠른 제어">🎲</div>');
        if ($('#send_but').length) diceButton.insertBefore('#send_but');
        else if ($('#rightSendForm').length) $('#rightSendForm').append(diceButton);
        else $('#send_form').append(diceButton);
    }
    if (!$('#td_quick_popover').length) $('body').append(quickPanelHtml());
    if (!$('#td_wand_container').length && $('#extensionsMenu').length) {
        $('#extensionsMenu').append('<div id="td_wand_container" class="extension_container"><div id="td_wand_entry"><i class="fa-solid fa-dice fa-fw"></i><span>굴려굴려</span></div></div>');
    }
    fillProfiles();
    bindUi();
    bindPanelResize();
    restoreChatSnapshot();
    syncInputs();
    registerCommands();
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, prepareGeneration);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, () => {
        runtime.turnKey = '';
        runtime.retries = 0;
        runtime.retrying = false;
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        restoreChatSnapshot();
        refreshUi();
    });
    if (event_types.CONNECTION_PROFILE_LOADED) eventSource.on(event_types.CONNECTION_PROFILE_LOADED, fillProfiles);
    console.info('[Turn Director] loaded');
});
