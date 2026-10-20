'use strict';

// Generates the 12 noir character portraits in public/avatars/*.svg.
// Each character is described by a small config; the drawing code below is shared.
//   npm run avatars

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'avatars');

const CHARACTERS = {
  detective: {
    skin: '#d9a27e', hair: null, hat: { type: 'fedora', color: '#2a2622' },
    coat: '#6b5a3e', lapels: true, stubble: true, mouth: 'serious', brows: 'thick', scar: true,
  },
  accountant: {
    skin: '#f1c7a5', hair: { type: 'combed', color: '#4a3520' }, glasses: 'round',
    shirt: '#e9eef5', tie: '#7a1f1f', pocket: true, sweat: true, mouth: 'nervous', brows: 'worried',
  },
  singer: {
    skin: '#8d5a3b', hair: { type: 'slick', color: '#15151a' }, mustache: 'pencil',
    jacket: '#1c1c2e', bowtie: '#e0b43a', mouth: 'smile', brows: 'thin',
  },
  dame: {
    skin: '#f3d1b3', hair: { type: 'bob', color: '#b8462b' }, lips: '#c81d3a', earring: true,
    coat: '#7e1b2c', mouth: 'smile', lashes: true, brows: 'thin', hat: { type: 'pillbox', color: '#c81d3a' },
  },
  bookie: {
    skin: '#c68b5f', hair: null, hat: { type: 'bowler', color: '#161616' }, sunglasses: true,
    jacket: '#3a2e2e', mouth: 'smirk', brows: 'thick', shirt: '#f4f4f4', tie: '#1d6f42',
  },
  cabbie: {
    skin: '#e0b08a', hair: { type: 'short', color: '#2c2c2c' }, hat: { type: 'cap', color: '#f1c40f' },
    jacket: '#2f3b4a', mouth: 'smile', brows: 'thick', beard: true,
  },
  cop: {
    skin: '#e8b696', hair: { type: 'grey', color: '#b9b9b9' }, hat: { type: 'cap', color: '#1d3557' },
    jacket: '#1d3557', badge: true, mustache: 'walrus', mustacheColor: '#b9b9b9', mouth: 'serious', brows: 'thick',
  },
  pianist: {
    skin: '#6e4530', hair: { type: 'afro', color: '#141414' }, hat: { type: 'beret', color: '#7b2d26' },
    jacket: '#2e2e2e', mouth: 'smile', brows: 'thin', glasses: 'round-thin',
  },
  waitress: {
    skin: '#f0c8a0', hair: { type: 'bun', color: '#9b5a2a' }, lips: '#e0457b', jacket: '#e74c3c',
    pen: true, mouth: 'smile', brows: 'thin', lashes: true,
  },
  chemist: {
    skin: '#f5d0b0', hair: { type: 'messy', color: '#e7e7e7' }, glasses: 'square', labcoat: '#f2f2f2',
    shirt: '#9fd3c7', mouth: 'smile', brows: 'thin', wide: true,
  },
  bellhop: {
    skin: '#a46b43', hair: { type: 'short', color: '#111111' }, hat: { type: 'pillbox', color: '#c0392b' },
    jacket: '#c0392b', mouth: 'smile', brows: 'thick', buttons: true,
  },
  ogre: {
    skin: '#6e9a4f', hair: { type: 'short', color: '#1d1d1d' }, sunglasses: true,
    jacket: '#4a3a2c', shirt: '#dcdcdc', tie: '#8b1e1e', mouth: 'smirk', brows: 'thick',
  },
  painter: {
    skin: '#e3b08d', hair: { type: 'long', color: '#5a3a22' }, hat: { type: 'bandana', color: '#2e86de' },
    jacket: '#4a4a4a', mouth: 'smile', beard: true, smear: '#e84393', brows: 'thin',
  },
};

const hatShapes = {
  fedora: (c) => `
    <ellipse cx="100" cy="58" rx="66" ry="12" fill="${c}"/>
    <path d="M62 58 Q64 22 100 22 Q136 22 138 58 Z" fill="${c}"/>
    <path d="M62 50 Q100 42 138 50" stroke="#000" stroke-opacity=".35" stroke-width="5" fill="none"/>`,
  bowler: (c) => `
    <ellipse cx="100" cy="58" rx="54" ry="10" fill="${c}"/>
    <path d="M66 58 Q66 26 100 26 Q134 26 134 58 Z" fill="${c}"/>`,
  cap: (c) => `
    <path d="M62 62 Q64 30 100 30 Q136 30 138 62 Z" fill="${c}"/>
    <path d="M96 58 L150 66 Q152 72 140 72 L96 66 Z" fill="${c}"/>`,
  beret: (c) => `
    <ellipse cx="108" cy="46" rx="58" ry="20" fill="${c}" transform="rotate(-8 108 46)"/>
    <circle cx="112" cy="28" r="4" fill="${c}"/>`,
  pillbox: (c) => `
    <rect x="66" y="26" width="68" height="34" rx="6" fill="${c}"/>
    <ellipse cx="100" cy="60" rx="38" ry="5" fill="${c}"/>`,
  bandana: (c) => `
    <path d="M60 60 Q100 24 140 60 Q100 52 60 60 Z" fill="${c}"/>
    <path d="M60 60 Q100 52 140 60 Q128 74 100 70 Q72 74 60 60 Z" fill="${c}" opacity=".85"/>`,
};

function hairShape(h) {
  const c = h.color;
  switch (h.type) {
    case 'short': return `<path d="M60 84 Q56 40 100 40 Q146 40 140 84 Q130 58 100 56 Q72 58 60 84 Z" fill="${c}"/>`;
    case 'slick': return `<path d="M58 86 Q56 42 100 40 Q146 42 142 86 Q132 56 100 54 Q68 56 58 86 Z" fill="${c}"/><path d="M76 52 Q100 46 124 52" stroke="#fff" stroke-opacity=".25" stroke-width="3" fill="none"/>`;
    case 'combed': return `<path d="M60 82 Q58 46 100 42 Q140 44 140 82 Q128 60 100 58 Q74 60 60 82 Z" fill="${c}"/><path d="M84 46 Q104 42 120 52" stroke="#000" stroke-opacity=".25" stroke-width="2" fill="none"/>`;
    case 'bob': return `<path d="M52 130 Q46 46 100 40 Q154 46 148 130 L138 130 Q136 66 100 62 Q64 66 62 130 Z" fill="${c}"/>`;
    case 'grey': return `<path d="M62 80 Q60 48 100 44 Q140 48 138 80 Q126 62 100 60 Q74 62 62 80 Z" fill="${c}"/>`;
    case 'afro': return `<circle cx="100" cy="82" r="66" fill="${c}"/>`;
    case 'bun': return `<path d="M60 84 Q56 42 100 40 Q144 42 140 84 Q128 60 100 58 Q72 60 60 84 Z" fill="${c}"/><circle cx="100" cy="30" r="16" fill="${c}"/>`;
    case 'messy': return `<path d="M58 86 Q52 42 100 38 Q150 42 142 86 Q134 58 118 56 Q108 46 92 56 Q74 56 58 86 Z" fill="${c}"/>`;
    case 'long': return `<path d="M54 140 Q46 44 100 40 Q154 44 146 140 L134 140 Q132 62 100 60 Q68 62 66 140 Z" fill="${c}"/>`;
    default: return '';
  }
}

function eyes(c) {
  const wide = c.wide ? 1.25 : 1;
  const lash = c.lashes ? `<path d="M76 92 l-6 -4 M124 92 l6 -4" stroke="#111" stroke-width="2.4" stroke-linecap="round"/>` : '';
  return `
    <ellipse cx="82" cy="94" rx="${5 * wide}" ry="${4.2 * wide}" fill="#1b1b1b"/>
    <ellipse cx="118" cy="94" rx="${5 * wide}" ry="${4.2 * wide}" fill="#1b1b1b"/>
    <circle cx="83.5" cy="92.5" r="1.4" fill="#fff" opacity=".8"/>
    <circle cx="119.5" cy="92.5" r="1.4" fill="#fff" opacity=".8"/>${lash}`;
}

function brows(c) {
  const type = c.brows || 'thin';
  const w = type === 'thick' ? 5 : type === 'worried' ? 2.5 : 2.5;
  const tilt = type === 'worried' ? 'M70 82 L92 86 M130 82 L108 86' : 'M70 84 Q82 80 92 84 M108 84 Q118 80 130 84';
  return `<path d="${tilt}" stroke="${c.hairColorBrow || '#1e1510'}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
}

function mouth(c) {
  const lips = c.lips;
  const fill = lips ? `fill="${lips}"` : 'fill="none"';
  const stroke = lips ? '' : 'stroke="#3a1c14" stroke-width="2.6" stroke-linecap="round"';
  switch (c.mouth) {
    case 'smile': return `<path d="M86 124 Q100 138 114 124 Q100 130 86 124 Z" ${fill} ${stroke}/>`;
    case 'smirk': return `<path d="M88 126 Q104 134 116 120" fill="none" stroke="#3a1c14" stroke-width="2.6" stroke-linecap="round"/>`;
    case 'nervous': return `<path d="M88 126 q4 -4 8 0 t8 0 t8 0 t8 0" fill="none" stroke="#3a1c14" stroke-width="2.4" stroke-linecap="round"/>`;
    default: return `<path d="M88 126 L112 126" stroke="#3a1c14" stroke-width="3" stroke-linecap="round"/>`;
  }
}

function glasses(type) {
  if (type === 'round') return `<circle cx="82" cy="94" r="12" fill="none" stroke="#222" stroke-width="2.6"/><circle cx="118" cy="94" r="12" fill="none" stroke="#222" stroke-width="2.6"/><path d="M94 94 Q100 90 106 94" stroke="#222" stroke-width="2.6" fill="none"/>`;
  if (type === 'round-thin') return `<circle cx="82" cy="94" r="11" fill="none" stroke="#c9a63a" stroke-width="1.8"/><circle cx="118" cy="94" r="11" fill="none" stroke="#c9a63a" stroke-width="1.8"/><path d="M93 94 L107 94" stroke="#c9a63a" stroke-width="1.8"/>`;
  if (type === 'square') return `<rect x="69" y="84" width="26" height="20" rx="3" fill="none" stroke="#1d1d1d" stroke-width="2.6"/><rect x="105" y="84" width="26" height="20" rx="3" fill="none" stroke="#1d1d1d" stroke-width="2.6"/><path d="M95 92 L105 92" stroke="#1d1d1d" stroke-width="2.6"/>`;
  return '';
}

function mustacheShape(type, color) {
  if (type === 'pencil') return `<path d="M88 116 Q100 112 112 116" stroke="${color || '#1a1a1a'}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  if (type === 'walrus') return `<path d="M84 118 Q100 110 116 118 Q114 128 100 124 Q86 128 84 118 Z" fill="${color || '#888'}"/>`;
  return '';
}

function stubble() {
  let dots = '';
  for (let x = 74; x <= 126; x += 5) for (let y = 110; y <= 140; y += 5) {
    if ((x * 7 + y * 3) % 4 === 0) dots += `<circle cx="${x}" cy="${y}" r=".9" fill="#2a1d14" opacity=".55"/>`;
  }
  return dots;
}

function beard(color = '#2a1d14') {
  return `<path d="M68 104 Q70 142 100 146 Q130 142 132 104 Q124 128 100 130 Q76 128 68 104 Z" fill="${color}" opacity=".9"/>`;
}

function build(id, c) {
  const body = c.labcoat
    ? `<path d="M28 200 Q30 146 100 134 Q170 146 172 200 Z" fill="${c.shirt || '#333'}"/><path d="M100 134 L100 200" stroke="#ccc" stroke-width="2"/><path d="M100 146 L76 176 L100 162 Z M100 146 L124 176 L100 162 Z" fill="${c.labcoat}"/>`
    : c.lapels
      ? `<path d="M26 200 Q28 140 100 130 Q172 140 174 200 Z" fill="${c.coat}"/><path d="M78 134 L100 176 L92 200 L70 150 Z M122 134 L100 176 L108 200 L130 150 Z" fill="#4a3f2c"/><path d="M76 130 L100 170 L124 130" fill="none" stroke="#3a3024" stroke-width="2"/>`
      : `<path d="M26 200 Q28 140 100 130 Q172 140 174 200 Z" fill="${c.jacket || c.coat || '#333'}"/>`
          + (c.shirt ? `<path d="M84 132 L100 170 L116 132 Z" fill="${c.shirt}"/>` : '')
          + (c.tie ? `<path d="M96 134 L104 134 L108 178 L100 190 L92 178 Z" fill="${c.tie}"/>` : '')
          + (c.bowtie ? `<path d="M80 136 L100 144 L80 152 Z M120 136 L100 144 L120 152 Z" fill="${c.bowtie}"/><circle cx="100" cy="144" r="3" fill="${c.bowtie}"/>` : '')
          + (c.buttons ? [160, 176, 192].map((y) => `<circle cx="100" cy="${y}" r="2.2" fill="#f4e7b1"/>`).join('') : '');

  const neck = `<rect x="88" y="118" width="24" height="18" fill="${c.skin}"/>`;
  const head = `<ellipse cx="100" cy="92" rx="40" ry="48" fill="${c.skin}"/><ellipse cx="60" cy="96" rx="6" ry="9" fill="${c.skin}"/><ellipse cx="140" cy="96" rx="6" ry="9" fill="${c.skin}"/>`;
  const hairBehind = c.hair && c.hair.type === 'afro' ? hairShape(c.hair) : '';
  const hairFront = c.hair && c.hair.type !== 'afro' ? hairShape(c.hair) : '';
  const hat = c.hat ? hatShapes[c.hat.type](c.hat.color) : '';
  const stub = c.stubble ? stubble() : '';
  const beardShape = c.beard ? beard(c.hair && c.hair.type === 'grey' ? '#b9b9b9' : '#2a1d14') : '';
  const sun = c.sunglasses
    ? `<rect x="66" y="84" width="30" height="20" rx="8" fill="#0d0d0d"/><rect x="104" y="84" width="30" height="20" rx="8" fill="#0d0d0d"/><path d="M96 92 L104 92" stroke="#0d0d0d" stroke-width="3"/><path d="M72 88 L80 88" stroke="#fff" stroke-opacity=".5" stroke-width="2"/>`
    : '';
  const earring = c.earring ? `<circle cx="61" cy="112" r="3.4" fill="#f3c742"/><circle cx="139" cy="112" r="3.4" fill="#f3c742"/>` : '';
  const scar = c.scar ? `<path d="M118 78 L128 92" stroke="#7a3a2c" stroke-width="2" stroke-linecap="round"/>` : '';
  const badge = c.badge ? `<path d="M130 150 l3 -6 l3 6 l-1 -4 h-4 z" fill="#f3c742"/><circle cx="133" cy="150" r="4" fill="#f3c742" stroke="#8a6a12" stroke-width="1"/>` : '';
  const pen = c.pen ? `<path d="M128 74 L138 60" stroke="#222" stroke-width="3" stroke-linecap="round"/><path d="M128 74 L138 60" stroke="#f3c742" stroke-width="1" stroke-linecap="round"/>` : '';
  const pocket = c.pocket ? `<rect x="112" y="150" width="14" height="16" fill="#c5d0dd"/><path d="M116 150 V160 M120 150 V160" stroke="#2e6fbf" stroke-width="2"/>` : '';
  const sweat = c.sweat ? `<path d="M140 74 q6 9 0 14 q-6 -5 0 -14 z" fill="#8fd3ff"/>` : '';
  const smear = c.smear ? `<path d="M64 116 q6 -6 12 -2 q6 4 10 -2" stroke="${c.smear}" stroke-width="4" fill="none" stroke-linecap="round"/>` : '';

  const background = `
    <defs>
      <radialGradient id="spot" cx="50%" cy="28%" r="70%">
        <stop offset="0%" stop-color="#3b3016"/>
        <stop offset="55%" stop-color="#15192a"/>
        <stop offset="100%" stop-color="#07080d"/>
      </radialGradient>
      <linearGradient id="grain" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".05"/>
        <stop offset="1" stop-color="#000" stop-opacity=".25"/>
      </linearGradient>
    </defs>
    <rect width="200" height="200" fill="url(#spot)"/>
    <rect width="200" height="200" fill="url(#grain)"/>
    <path d="M0 200 L0 170 Q100 150 200 170 L200 200 Z" fill="#050608" opacity=".6"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="${id}">
  ${background}
  ${hairBehind}
  ${body}
  ${neck}
  ${head}
  ${hairFront}
  ${earring}
  ${stub}
  ${beardShape}
  ${eyes(c)}
  ${brows(c)}
  ${glasses(c.glasses)}
  ${sun}
  ${scar}
  ${mustacheShape(c.mustache, c.mustacheColor)}
  ${mouth(c)}
  ${smear}
  ${sweat}
  ${pocket}
  ${pen}
  ${badge}
  ${hat}
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [id, cfg] of Object.entries(CHARACTERS)) {
  const merged = { ...cfg, hairColorBrow: cfg.hair ? cfg.hair.color : '#1e1510' };
  fs.writeFileSync(path.join(OUT, `${id}.svg`), build(id, merged));
}
console.log(`Wrote ${Object.keys(CHARACTERS).length} avatars to ${OUT}`);
