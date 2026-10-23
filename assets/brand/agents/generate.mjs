// Draws the default agent portraits (one per template) in Boss Man's cartoon style:
// thick dark outlines, big round eyes, flat warm colours. Run: node assets/brand/agents/generate.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INK = "#262626";
const s = (w = 5) => `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const SKIN = { light: ["#f8d3b4", "#e9b48f"], tan: ["#e7b48a", "#cf9467"], brown: ["#b97c52", "#9a6239"], dark: ["#7a4b2c", "#5f3820"] };

const brows = {
  calm: `<path d="M90 86 Q104 79 118 86 M138 86 Q152 79 166 86" fill="none" ${s(6)}/>`,
  raised: `<path d="M90 84 Q104 74 118 84 M138 80 Q152 70 166 78" fill="none" ${s(6)}/>`,
  sly: `<path d="M90 82 L118 88 M138 88 L166 80" fill="none" ${s(7)}/>`,
};
const mouths = {
  grin: () => `<path d="M108 146 Q128 166 148 146 Q128 152 108 146 Z" fill="#7a2a22" ${s(4)}/><path d="M118 154 Q128 160 138 154" fill="#e8777a"/>`,
  smile: () => `<path d="M110 148 Q128 162 146 148" fill="none" ${s()}/>`,
  smirk: () => `<path d="M112 152 Q132 156 148 142" fill="none" ${s()}/>`,
};

function face({ skin = "light", brow = "calm", mouth = "grin", glasses = "", beard = "" }) {
  const [base, shade] = SKIN[skin];
  return `
  <rect x="112" y="160" width="32" height="30" fill="${base}" ${s()}/>
  <circle cx="63" cy="120" r="14" fill="${base}" ${s()}/><circle cx="193" cy="120" r="14" fill="${base}" ${s()}/>
  <ellipse cx="128" cy="114" rx="64" ry="70" fill="${base}" ${s()}/>
  <ellipse cx="88" cy="136" rx="12" ry="7" fill="#ef8a8a" opacity=".45"/><ellipse cx="168" cy="136" rx="12" ry="7" fill="#ef8a8a" opacity=".45"/>
  ${beard ? beard : ""}
  <ellipse cx="106" cy="108" rx="15" ry="17" fill="#fff" ${s(4)}/><ellipse cx="150" cy="108" rx="15" ry="17" fill="#fff" ${s(4)}/>
  <circle cx="108" cy="111" r="7" fill="${INK}"/><circle cx="148" cy="111" r="7" fill="${INK}"/>
  <circle cx="110.5" cy="108" r="2.4" fill="#fff"/><circle cx="150.5" cy="108" r="2.4" fill="#fff"/>
  ${brows[brow]}
  <ellipse cx="128" cy="131" rx="11" ry="9" fill="${shade}" ${s(4)}/>
  ${mouths[mouth]()}
  ${glasses}`;
}

const shoulders = (fill, extra = "") => `<path d="M34 262 C36 206 78 184 128 184 C178 184 220 206 222 262 Z" fill="${fill}" ${s()}/>${extra}`;
const collar = (fill = "#fff") => `<path d="M104 186 L128 214 L152 186 L142 182 L128 196 L114 182 Z" fill="${fill}" ${s(4)}/>`;
const roundGlasses = `<g fill="none" ${s(4)}><circle cx="106" cy="109" r="20"/><circle cx="150" cy="109" r="20"/><path d="M126 108 L130 108 M86 104 L66 98 M170 104 L190 98"/></g>`;
const squareGlasses = `<g fill="rgba(255,255,255,.15)" ${s(5)}><rect x="84" y="92" width="44" height="34" rx="6"/><rect x="128" y="92" width="44" height="34" rx="6"/><path d="M84 104 L66 98 M172 104 L190 98" fill="none"/></g>`;
const halfMoon = `<g fill="none" ${s(4)}><path d="M88 112 Q106 132 124 112 Z M132 112 Q150 132 168 112 Z M124 112 L132 112"/></g>`;
const headset = (c = "#3a3f4b") => `<path d="M64 112 Q64 34 128 34 Q192 34 192 112" fill="none" ${s(7)}/><rect x="52" y="100" width="18" height="30" rx="8" fill="${c}" ${s(4)}/><rect x="186" y="100" width="18" height="30" rx="8" fill="${c}" ${s(4)}/><path d="M60 128 Q70 162 104 160" fill="none" ${s(4)}/><circle cx="106" cy="160" r="6" fill="${c}" ${s(3)}/>`;
// Drawn at (172, 226) and lifted into the crop.
const badge = (fill, glyph) => `<g transform="translate(-4 -22)"><circle cx="172" cy="226" r="17" fill="${fill}" ${s(4)}/>${glyph}</g>`;

const PEOPLE = {
  engineer: {
    title: "Engineer",
    back: "",
    body: shoulders("#3f8f5f", `<path d="M112 188 L112 230 M144 188 L144 230" ${s(4)}/><circle cx="112" cy="232" r="4" fill="${INK}"/><circle cx="144" cy="232" r="4" fill="${INK}"/>`),
    face: { skin: "tan" },
    hair: `<path d="M64 104 Q60 40 128 38 Q196 40 192 104 L180 82 L170 96 L160 72 L146 88 L136 64 L122 86 L110 62 L98 88 L86 70 L78 94 Z" fill="#3b2a20" ${s()}/>`,
  },
  researcher: {
    title: "Researcher",
    back: `<path d="M58 140 Q40 60 128 42 Q216 60 198 140 Q206 90 128 70 Q50 90 58 140 Z" fill="#c4572e" ${s()}/>`,
    body: shoulders("#f4f4f2", `${collar("#7aa6d8")}<path d="M128 214 L128 262" ${s(4)}/>`),
    face: { skin: "light", glasses: roundGlasses, brow: "raised" },
    hair: `<g fill="#c4572e" ${s(4)}><circle cx="78" cy="70" r="18"/><circle cx="100" cy="54" r="18"/><circle cx="128" cy="48" r="19"/><circle cx="156" cy="54" r="18"/><circle cx="178" cy="70" r="18"/><circle cx="66" cy="94" r="14"/><circle cx="190" cy="94" r="14"/></g>`,
  },
  designer: {
    title: "Designer",
    back: `<path d="M60 150 Q48 60 128 50 Q208 60 196 150 L182 150 Q186 92 128 84 Q70 92 74 150 Z" fill="#6b4bb5" ${s()}/>`,
    body: shoulders("#f2f2f2", `<path d="M42 226 H214 M38 246 H218" stroke="#e05a5a" stroke-width="10"/><path d="M34 262 C36 206 78 184 128 184 C178 184 220 206 222 262 Z" fill="none" ${s()}/>`),
    face: { skin: "brown", mouth: "smile" },
    hair: `<path d="M64 102 Q70 56 128 52 Q186 56 192 102 Q160 76 128 80 Q96 76 64 102 Z" fill="#6b4bb5" ${s()}/><path d="M70 64 Q86 24 140 28 Q192 34 196 58 Q160 50 70 64 Z" fill="${INK}" ${s()}/><circle cx="148" cy="26" r="6" fill="${INK}"/>`,
  },
  qa: {
    title: "QA",
    back: `<path d="M182 70 Q226 96 210 160 Q204 120 186 104 Z" fill="#e6b83c" ${s()}/>`,
    body: shoulders("#2e9c9c", badge("#3fb86b", `<path d="M164 226 L170 233 L181 219" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`)),
    face: { skin: "light" },
    hair: `<path d="M64 108 Q56 42 128 40 Q200 42 192 108 Q178 70 128 66 Q86 68 64 108 Z" fill="#e6b83c" ${s()}/><circle cx="190" cy="76" r="9" fill="#e05a5a" ${s(4)}/>`,
  },
  writer: {
    title: "Writer",
    back: "",
    body: shoulders("#8e3048", `${collar()}<circle cx="128" cy="226" r="4" fill="${INK}"/><circle cx="128" cy="244" r="4" fill="${INK}"/>`),
    face: { skin: "light", glasses: halfMoon, mouth: "smile" },
    hair: `<path d="M64 106 Q58 46 128 44 Q198 46 192 106 Q176 72 128 70 Q80 72 64 106 Z" fill="#b8b8bd" ${s()}/><circle cx="128" cy="34" r="20" fill="#b8b8bd" ${s()}/><path d="M112 26 L150 50" ${s(4)}/>`,
  },
  "scrum-master": {
    title: "Scrum Master",
    back: "",
    body: shoulders("#2f6fb8", `<path d="M108 186 Q128 226 148 186" fill="none" ${s(3)}/><rect x="118" y="220" width="22" height="12" rx="5" fill="#d9d9d9" ${s(3)}/>`),
    face: { skin: "dark" },
    hair: `<path d="M62 96 Q60 40 128 38 Q196 40 194 96 Z" fill="#f08a2b" ${s()}/><path d="M60 96 Q128 80 224 100 Q218 112 192 104 Q128 92 60 104 Z" fill="#f08a2b" ${s()}/><circle cx="128" cy="40" r="6" fill="#f08a2b" ${s(3)}/>`,
  },
  assistant: {
    title: "Assistant",
    back: "",
    body: shoulders("#2c3e66", collar()),
    face: { skin: "tan", mouth: "smile" },
    hair: `<path d="M64 104 Q58 40 128 40 Q198 40 192 104 Q186 66 150 62 Q120 82 70 92 Z" fill="#1f1a17" ${s()}/>`,
    over: headset(),
  },
  "senior-dev": {
    title: "Senior Developer",
    back: "",
    body: shoulders("#3a3f4b", `<path d="M110 186 Q128 200 146 186" fill="none" ${s(4)}/>`),
    face: { skin: "light", glasses: squareGlasses, beard: `<path d="M68 128 Q72 196 128 200 Q184 196 188 128 Q176 168 128 170 Q80 168 68 128 Z" fill="#8a8a90" ${s(4)}/>` },
    hair: `<path d="M64 112 Q60 70 78 56 Q86 80 82 108 Z M192 112 Q196 70 178 56 Q170 80 174 108 Z" fill="#8a8a90" ${s(4)}/>`,
  },
  "security-reviewer": {
    title: "Security Reviewer",
    back: "",
    body: shoulders("#24262b", `${collar()}<path d="M164 214 L180 214 L180 226 Q180 238 172 242 Q164 238 164 226 Z" fill="#e8c14a" ${s(3)}/>`),
    face: { skin: "brown", brow: "sly", mouth: "smile" },
    hair: `<path d="M66 100 Q60 46 128 44 Q196 46 190 100 Q182 70 128 68 Q74 70 66 100 Z" fill="#141414" ${s()}/>`,
    over: `<path d="M196 118 Q212 140 200 168" fill="none" ${s(3)}/>`,
  },
  "adversarial-reviewer": {
    title: "Adversarial Reviewer",
    back: "",
    body: shoulders("#1c1c1f", `<path d="M98 188 Q128 204 158 188 L158 200 Q128 214 98 200 Z" fill="#1c1c1f" ${s(4)}/>`),
    face: { skin: "light", brow: "sly", mouth: "smirk" },
    hair: `<path d="M64 102 L58 50 L84 70 L92 34 L112 62 L128 28 L144 62 L164 34 L172 70 L198 50 L192 102 Q128 70 64 102 Z" fill="#b32d2d" ${s()}/>`,
  },
  "senior-infra": {
    title: "Senior Infrastructure Engineer",
    back: "",
    body: shoulders("#f07f1e", `<path d="M96 186 L96 262 M160 186 L160 262" stroke="#f3e64a" stroke-width="12"/><path d="M34 262 C36 206 78 184 128 184 C178 184 220 206 222 262 Z" fill="none" ${s()}/>`),
    face: { skin: "tan", beard: `<path d="M98 146 Q128 136 158 146 Q150 140 128 140 Q106 140 98 146 Z" fill="#4a3426" ${s(3)}/>` },
    hair: `<path d="M56 92 Q58 30 128 28 Q198 30 200 92 Z" fill="#f2c430" ${s()}/><path d="M44 96 Q128 80 212 96 L212 104 Q128 90 44 104 Z" fill="#f2c430" ${s()}/><path d="M120 30 L120 90 M136 30 L136 90" ${s(4)}/>`,
  },
  "product-manager": {
    title: "Product Manager",
    back: "",
    body: shoulders("#9cc3e8", `${collar("#cfe2f4")}<path d="M110 190 Q128 236 146 190" fill="none" stroke="#e05a5a" stroke-width="4"/><rect x="118" y="230" width="20" height="24" rx="3" fill="#fff" ${s(3)}/>`),
    face: { skin: "light" },
    hair: `<path d="M64 106 Q56 44 128 40 Q200 44 192 106 Q186 70 160 64 Q110 70 76 84 Z" fill="#6b4126" ${s()}/>`,
  },
  "release-manager": {
    title: "Release Manager",
    back: "",
    body: shoulders("#7b4fb8", badge("#f2f2f2", `<path d="M172 214 Q180 222 176 234 L168 234 Q164 222 172 214 Z" fill="#e05a5a" stroke="${INK}" stroke-width="2.5"/>`)),
    face: { skin: "dark", mouth: "grin" },
    hair: `<path d="M64 104 Q60 54 92 40 Q130 18 172 36 Q200 56 192 104 Q186 74 150 66 Q104 70 64 104 Z" fill="#141414" ${s()}/>`,
  },
  "data-analytics": {
    title: "Data &amp; Analytics",
    back: `<path d="M60 150 Q40 70 128 46 Q216 70 196 150 Z" fill="#2a1d16" ${s()}/>`,
    body: shoulders("#2b8a7e", badge("#fff", `<path d="M172 226 L172 210 A16 16 0 0 1 188 226 Z" fill="#f2c430" stroke="${INK}" stroke-width="2.5"/>`)),
    face: { skin: "brown", glasses: squareGlasses, mouth: "smile" },
    hair: `<path d="M64 104 Q60 48 128 46 Q196 48 192 104 Q176 74 128 72 Q80 74 64 104 Z" fill="#2a1d16" ${s()}/>`,
  },
  support: {
    title: "Support",
    back: "",
    body: shoulders("#f0b429", `<circle cx="120" cy="226" r="4" fill="${INK}"/><circle cx="120" cy="246" r="4" fill="${INK}"/>`),
    face: { skin: "dark", mouth: "grin" },
    hair: `<g fill="#1f1611" ${s(4)}><circle cx="74" cy="80" r="22"/><circle cx="98" cy="56" r="24"/><circle cx="128" cy="48" r="25"/><circle cx="158" cy="56" r="24"/><circle cx="182" cy="80" r="22"/></g>`,
    over: headset("#e05a5a"),
  },
  // Not a template: Boss Man's built-in wiki keeper (duty "wiki").
  wiki: {
    title: "Wiki Maintainer",
    back: "",
    body: shoulders("#5a7d4f", `${collar()}<path d="M114 196 L128 204 L114 212 Z M142 196 L128 204 L142 212 Z" fill="#c43d3d" ${s(3)}/>${badge("#f4e6c8", `<path d="M162 218 L172 222 L182 218 L182 234 L172 238 L162 234 Z M172 222 L172 238" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`)}`),
    face: { skin: "tan", glasses: roundGlasses, mouth: "smile" },
    hair: `<path d="M64 106 Q58 44 128 42 Q198 44 192 106 Q178 64 128 62 Q96 62 76 80 Z" fill="#5b3a29" ${s()}/>`,
  },
};

function svg(p) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="26 18 204 204" role="img"><title>${p.title}</title>${p.back}${p.body}${face(p.face)}${p.hair}${p.over ?? ""}</svg>\n`;
}

const dir = fileURLToPath(new URL(".", import.meta.url));
for (const [id, p] of Object.entries(PEOPLE)) writeFileSync(`${dir}${id}.svg`, svg(p));
console.log(Object.keys(PEOPLE).length, "portraits written");
