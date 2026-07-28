// Three deliberately distinct presenter portraits (per spec v1.2 §5.3 FR-15b):
//   amara  - Black woman with voluminous curly/afro hair
//   daniel - White man with a neat short haircut
//   meilin - Chinese woman with a ponytail
//
// These are stylized, higher-detail placeholder illustrations. Per spec §10.3 /
// §10.7 the *delivery* target is a realistic, video-quality avatar (real-time
// photoreal 3D / neural talking-head); that pipeline is pluggable and lives
// behind this same render surface. `mouth` toggles lip-sync; `state` handles the
// listening tilt.

function eyes(cx, cy, browColor, skinShade, px) {
  return `
    <ellipse cx="${cx - 15}" cy="${cy}" rx="6.5" ry="7" fill="#fff"/>
    <ellipse cx="${cx + 15}" cy="${cy}" rx="6.5" ry="7" fill="#fff"/>
    <circle cx="${px - 15}" cy="${cy + 1}" r="3.3" fill="#2a2130"/>
    <circle cx="${px + 15}" cy="${cy + 1}" r="3.3" fill="#2a2130"/>
    <circle cx="${px - 16}" cy="${cy - 1}" r="1" fill="#fff"/>
    <circle cx="${px + 14}" cy="${cy - 1}" r="1" fill="#fff"/>`;
}

function mouthShape(open, lip, cy, listening) {
  if (open) {
    return `<ellipse cx="100" cy="${cy}" rx="9" ry="7" fill="#6f3630"/>
            <ellipse cx="100" cy="${cy + 3}" rx="5.5" ry="3" fill="#c96a5e"/>`;
  }
  return `<path d="M90 ${cy - 1} Q100 ${cy + (listening ? 7 : 4)} 110 ${cy - 1}" stroke="${lip}" stroke-width="3.4" fill="none" stroke-linecap="round"/>`;
}

/* ---- Amara: Black woman, voluminous curly/afro hair ---- */
function amara(mouth, listening, px) {
  const skin = '#6B4A38'; const shade = '#573B2C'; const lip = '#8A4A44'; const hair = '#181210';
  // afro built from a cloud of circles
  let afro = '';
  const puffs = [[100, 46, 40], [64, 58, 26], [136, 58, 26], [52, 88, 22], [148, 88, 22], [70, 40, 22], [130, 40, 22], [100, 34, 26], [58, 74, 20], [142, 74, 20]];
  for (const [x, y, r] of puffs) afro += `<circle cx="${x}" cy="${y}" r="${r}" fill="${hair}"/>`;
  return `
    <path d="M36 240 Q38 178 74 164 L126 164 Q162 178 164 240 Z" fill="#17B7A6"/>
    <path d="M74 164 L126 164 Q136 172 138 188 L62 188 Q64 172 74 164 Z" fill="#0E7F74"/>
    <g transform="${listening ? 'rotate(-6 100 96)' : ''}" style="transition:transform .35s ease">
      ${afro}
      <path d="M72 150 L78 132 L122 132 L128 150 Z" fill="${shade}"/>
      <ellipse cx="100" cy="98" rx="40" ry="45" fill="${skin}"/>
      <path d="M60 98 Q58 120 74 132 Q64 110 66 92 Z" fill="${shade}" opacity=".5"/>
      <circle cx="62" cy="102" r="6" fill="${shade}"/><circle cx="138" cy="102" r="6" fill="${shade}"/>
      <circle cx="62" cy="112" r="4.5" fill="none" stroke="#FFCB47" stroke-width="2.5"/>
      <circle cx="138" cy="112" r="4.5" fill="none" stroke="#FFCB47" stroke-width="2.5"/>
      <path d="M78 84 Q86 80 94 84" stroke="${hair}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M106 84 Q114 80 122 84" stroke="${hair}" stroke-width="3" fill="none" stroke-linecap="round"/>
      ${eyes(100, 92, hair, shade, px)}
      <path d="M100 98 Q97 108 101 112" stroke="${shade}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      ${mouthShape(mouth, lip, 122, listening)}
    </g>`;
}

/* ---- Daniel: White man, neat short haircut ---- */
function daniel(mouth, listening, px) {
  const skin = '#E9B98F'; const shade = '#D3A176'; const lip = '#B06A5C'; const hair = '#4A341F';
  return `
    <path d="M32 240 Q34 176 72 162 L128 162 Q166 176 168 240 Z" fill="#2B3A55"/>
    <path d="M72 162 L100 176 L128 162 L128 168 L100 186 L72 168 Z" fill="#3C4E70"/>
    <path d="M92 158 L108 158 L106 176 L94 176 Z" fill="${shade}"/>
    <g transform="${listening ? 'rotate(-6 100 96)' : ''}" style="transition:transform .35s ease">
      <path d="M74 150 L80 138 L120 138 L126 150 Z" fill="${shade}"/>
      <rect x="72" y="96" width="56" height="52" rx="20" fill="${skin}"/>
      <ellipse cx="100" cy="96" rx="40" ry="43" fill="${skin}"/>
      <circle cx="61" cy="100" r="6" fill="${shade}"/><circle cx="139" cy="100" r="6" fill="${shade}"/>
      <path d="M60 84 Q58 58 100 54 Q142 58 140 84 Q140 70 128 66 Q100 60 72 66 Q60 70 60 84 Z" fill="${hair}"/>
      <path d="M60 84 Q70 74 84 76 L82 66 Q68 68 60 84 Z" fill="${hair}"/>
      <rect x="78" y="84" width="16" height="3.6" rx="1.8" fill="${hair}"/>
      <rect x="106" y="84" width="16" height="3.6" rx="1.8" fill="${hair}"/>
      ${eyes(100, 94, hair, shade, px)}
      <path d="M100 100 Q97 109 101 113" stroke="${shade}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      ${mouthShape(mouth, lip, 124, listening)}
      <path d="M84 138 Q100 146 116 138" stroke="${shade}" stroke-width="1.6" fill="none" opacity=".5"/>
    </g>`;
}

/* ---- Mei-Lin: Chinese woman, ponytail ---- */
function meilin(mouth, listening, px) {
  const skin = '#F0C9A0'; const shade = '#E0B488'; const lip = '#C15A55'; const hair = '#1B1620';
  return `
    <path d="M34 240 Q36 178 74 164 L126 164 Q164 178 166 240 Z" fill="#FF6A55"/>
    <path d="M74 164 L126 164 Q136 172 138 188 L62 188 Q64 172 74 164 Z" fill="#D94E3B"/>
    <g transform="${listening ? 'rotate(-6 100 96)' : ''}" style="transition:transform .35s ease">
      <!-- ponytail behind, swept to the side -->
      <path d="M132 70 Q170 96 160 150 Q156 174 140 176 Q156 150 150 118 Q146 92 128 84 Z" fill="${hair}"/>
      <path d="M74 150 L80 136 L120 136 L126 150 Z" fill="${shade}"/>
      <ellipse cx="100" cy="96" rx="39" ry="44" fill="${skin}"/>
      <!-- sleek hair cap + center part + tie -->
      <path d="M60 92 Q56 50 100 48 Q144 50 140 92 Q140 66 122 60 L118 74 Q100 66 82 74 L78 60 Q60 66 60 92 Z" fill="${hair}"/>
      <path d="M100 48 L100 66" stroke="#000" stroke-width="1.4" opacity=".4"/>
      <circle cx="130" cy="78" r="5" fill="#FFCB47"/>
      <circle cx="61" cy="100" r="5.5" fill="${shade}"/><circle cx="139" cy="100" r="5.5" fill="${shade}"/>
      <path d="M79 86 Q87 82 95 86" stroke="${hair}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <path d="M105 86 Q113 82 121 86" stroke="${hair}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      ${eyes(100, 93, hair, shade, px)}
      <path d="M100 99 Q97 108 101 112" stroke="${shade}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      ${mouthShape(mouth, lip, 122, listening)}
    </g>`;
}

/* ---- Alex: stand-in portrait for the photo-based avatar (until model.glb is added) ----
   Approximates the source photo: light skin, short dark hair greying at the
   temples, clean-shaven, warm smile, teal tee under a black zip jacket. */
function alex(mouth, listening, px) {
  const skin = '#E7B892'; const shade = '#D2A074'; const lip = '#B26A5B';
  const hair = '#2C2621'; const grey = '#9A938C';
  return `
    <path d="M28 240 Q30 172 70 158 L130 158 Q170 172 172 240 Z" fill="#14100E"/>
    <path d="M84 156 Q100 176 116 156 L118 176 Q100 190 82 176 Z" fill="#4FD0C4"/>
    <rect x="97" y="150" width="6" height="70" rx="3" fill="#3a3733"/>
    <circle cx="100" cy="176" r="3.2" fill="#8f8a85"/>
    <path d="M74 168 L82 150 L118 150 L126 168 L118 158 L82 158 Z" fill="#221d19"/>
    <g transform="${listening ? 'rotate(-6 100 96)' : ''}" style="transition:transform .35s ease">
      <path d="M74 150 L80 138 L120 138 L126 150 Z" fill="${shade}"/>
      <ellipse cx="100" cy="98" rx="41" ry="45" fill="${skin}"/>
      <ellipse cx="76" cy="112" rx="8" ry="6" fill="#e79a86" opacity=".35"/>
      <ellipse cx="124" cy="112" rx="8" ry="6" fill="#e79a86" opacity=".35"/>
      <circle cx="60" cy="100" r="6" fill="${shade}"/><circle cx="140" cy="100" r="6" fill="${shade}"/>
      <!-- short hair, slightly receding, grey at the temples -->
      <path d="M62 82 Q60 56 100 52 Q140 56 138 82 Q136 66 120 62 Q100 57 80 62 Q64 66 62 82 Z" fill="${hair}"/>
      <path d="M62 82 Q64 68 78 64 L80 76 Q68 74 62 82 Z" fill="${grey}" opacity=".7"/>
      <path d="M138 82 Q136 68 122 64 L120 76 Q132 74 138 82 Z" fill="${grey}" opacity=".7"/>
      <rect x="79" y="83" width="16" height="3.4" rx="1.7" fill="${hair}"/>
      <rect x="105" y="83" width="16" height="3.4" rx="1.7" fill="${hair}"/>
      ${eyes(100, 93, hair, shade, px)}
      <path d="M100 99 Q96 109 101 113" stroke="${shade}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      ${mouth
    ? `<ellipse cx="100" cy="122" rx="10" ry="7" fill="#6f3630"/><ellipse cx="100" cy="125" rx="6.5" ry="3" fill="#d0d0d0"/>`
    : `<path d="M86 120 Q100 ${listening ? 132 : 130} 114 120" stroke="${lip}" stroke-width="3.4" fill="none" stroke-linecap="round"/>`}
      <path d="M88 138 Q100 145 112 138" stroke="${shade}" stroke-width="1.4" fill="none" opacity=".4"/>
    </g>`;
}

/* ---- Mira: the course coach (warm, friendly; shoulder-length brown hair, teal top) ---- */
function mira(mouth, listening, px) {
  const skin = '#F0C9A8'; const shade = '#E0B48F'; const lip = '#C15A55'; const hair = '#4A2F22';
  return `
    <path d="M34 240 Q36 178 74 164 L126 164 Q164 178 166 240 Z" fill="#2F8F86"/>
    <path d="M74 164 L100 178 L126 164 L124 186 L100 196 L76 186 Z" fill="#227C74"/>
    <g transform="${listening ? 'rotate(-6 100 96)' : ''}" style="transition:transform .35s ease">
      <!-- hair behind, shoulder length -->
      <path d="M52 96 Q50 150 66 182 L80 176 Q66 150 68 108 Z" fill="${hair}"/>
      <path d="M148 96 Q150 150 134 182 L120 176 Q134 150 132 108 Z" fill="${hair}"/>
      <path d="M74 150 L80 136 L120 136 L126 150 Z" fill="${shade}"/>
      <ellipse cx="100" cy="96" rx="40" ry="45" fill="${skin}"/>
      <!-- soft fringe / center part -->
      <path d="M58 92 Q54 50 100 48 Q146 50 142 92 Q140 64 120 58 Q100 66 80 58 Q60 64 58 92 Z" fill="${hair}"/>
      <path d="M100 49 Q95 60 88 60" stroke="#000" stroke-width="1" opacity=".25" fill="none"/>
      <circle cx="61" cy="102" r="5.5" fill="${shade}"/><circle cx="139" cy="102" r="5.5" fill="${shade}"/>
      <path d="M79 86 Q87 82 95 86" stroke="${hair}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <path d="M105 86 Q113 82 121 86" stroke="${hair}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      ${eyes(100, 93, hair, shade, px)}
      <path d="M100 99 Q97 108 101 112" stroke="${shade}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      ${mouthShape(mouth, lip, 122, listening)}
      <ellipse cx="76" cy="112" rx="7" ry="5" fill="#E79A86" opacity=".3"/>
      <ellipse cx="124" cy="112" rx="7" ry="5" fill="#E79A86" opacity=".3"/>
    </g>`;
}

// yuri's card normally shows course-content/avatars/yuri.jpg (photo); the
// drawn fallback reuses the male 'alex' sketch only if the photo fails.
const RENDERERS = {
  mira, amara, daniel, meilin, alex, yuri: alex,
};

export function avatarSVG(id, { mouth = false, state = 'idle', k = 'a' } = {}) {
  const listening = state === 'listening';
  const px = listening ? 96 : 100;
  const render = RENDERERS[id] || mira;
  return `<svg viewBox="0 0 200 240" width="100%" height="100%" role="img" aria-label="presenter ${id}">
    <defs><clipPath id="cl${id}${k}"><rect width="200" height="240"/></clipPath></defs>
    <g clip-path="url(#cl${id}${k})">${render(mouth, listening, px)}</g>
  </svg>`;
}
