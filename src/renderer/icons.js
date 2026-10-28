// Small stroke icon set (24 × 24 grid), drawn for this app.

const PATHS = {
  logo: ['M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z', 'M3.5 7 12 11.5 20.5 7', 'M12 11.5v10'],
  home: ['M3.5 11 12 3.5l8.5 7.5', 'M5.5 9.5V20h13V9.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  clock: ['circle:12,12,8.5', 'M12 7.5V12l3 2'],
  overview: ['rect:3.5,3.5,7,7,1.5', 'rect:13.5,3.5,7,7,1.5', 'rect:3.5,13.5,7,7,1.5', 'rect:13.5,13.5,7,7,1.5'],
  box: ['M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z', 'M3.5 7 12 11.5 20.5 7', 'M12 11.5v10'],
  report: ['rect:5.5,4,13,17,2', 'M9 4h6v3H9z', 'M9 11h6', 'M9 15h4'],
  folder: ['M3.5 6.5h6l2 2h9v10.5h-17z'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M4.5 20h15'],
  x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13'],
  search: ['circle:11,11,6.5', 'M20 20l-4.3-4.3'],
  user: ['circle:12,8,4', 'M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6'],
  play: ['circle:12,12,8.5', 'M10 8.5l5.5 3.5-5.5 3.5z'],
  image: ['rect:3.5,4.5,17,15,2', 'circle:9,10,1.8', 'M20.5 16l-5-5-8.5 8.5'],
  sphere: ['circle:12,12,8.5', 'M7.5 9.5a5 5 0 0 1 4-3'],
  sparkle: ['M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9-1.9 5.6-1.9-5.6-5.6-1.9 5.6-1.9z'],
  music: ['M9 17.5V5.5l10.5-2v12', 'circle:6.5,17.5,2.5', 'circle:17,15.5,2.5'],
  video: ['rect:3.5,6,12.5,12,2', 'M16 10.5l4.5-3v9l-4.5-3'],
  map: ['M3.5 6.5l5.5-2.5 6 2.5 5.5-2.5v13.5l-5.5 2.5-6-2.5-5.5 2.5z', 'M9 4v13.5', 'M15 6.5V20'],
  layout: ['rect:3.5,3.5,17,17,2', 'M3.5 9h17', 'M9 9v11.5'],
  code: ['M8.5 7l-5 5 5 5', 'M15.5 7l5 5-5 5'],
  archive: ['rect:3.5,4,17,5,1', 'M5 9v11h14V9', 'M10 13h4'],
  file: ['M6.5 3.5h7l4.5 4.5v12.5h-11.5z', 'M13.5 3.5V8H18'],
  check: ['M5 12.5l4.5 4.5 9.5-10'],
  alert: ['M12 3.5l9.5 16.5h-19z', 'M12 10v4', 'M12 17.2v.3'],
  shield: ['M12 3l7.5 3v6c0 4.5-3.5 7.8-7.5 9-4-1.2-7.5-4.5-7.5-9V6z', 'M9 12l2 2 4-4'],
  chevronDown: ['M6.5 9.5l5.5 5.5 5.5-5.5'],
  external: ['M14 4.5h5.5V10', 'M19.5 4.5L11 13', 'M17.5 14v5.5h-13v-13H10'],
  cpu: ['rect:7,7,10,10,1.5', 'M4 10h3', 'M4 14h3', 'M17 10h3', 'M17 14h3', 'M10 4v3', 'M14 4v3', 'M10 17v3', 'M14 17v3'],
  layers: ['M12 3.5l8.5 4.5-8.5 4.5L3.5 8z', 'M3.5 12.5l8.5 4.5 8.5-4.5', 'M3.5 16.5l8.5 4.5 8.5-4.5'],
  sun: ['circle:12,12,4', 'M12 2.5v2', 'M12 19.5v2', 'M2.5 12h2', 'M19.5 12h2', 'M5.3 5.3l1.4 1.4', 'M17.3 17.3l1.4 1.4', 'M5.3 18.7l1.4-1.4', 'M17.3 6.7l1.4-1.4'],
  moon: ['M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z'],
  stop: ['circle:12,12,8.5', 'M9.5 9.5h5v5h-5z'],
  swap: ['M7.5 4L4 7.5l3.5 3.5', 'M4 7.5h14', 'M16.5 13l3.5 3.5-3.5 3.5', 'M20 16.5H6'],
  compare: ['rect:3.5,4.5,7,15,1.5', 'rect:13.5,4.5,7,15,1.5', 'M6 9h2', 'M6 12h2', 'M16 9h2', 'M16 12h2', 'M16 15h2'],
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 18) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const p of PATHS[name] || PATHS.file) {
    let node;
    if (p.startsWith('circle:')) {
      const [cx, cy, r] = p.slice(7).split(',');
      node = document.createElementNS(NS, 'circle');
      Object.entries({ cx, cy, r }).forEach(([k, v]) => node.setAttribute(k, v));
    } else if (p.startsWith('rect:')) {
      const [x, y, w, h, rx] = p.slice(5).split(',');
      node = document.createElementNS(NS, 'rect');
      Object.entries({ x, y, width: w, height: h, rx: rx || 0 }).forEach(([k, v]) => node.setAttribute(k, v));
    } else {
      node = document.createElementNS(NS, 'path');
      node.setAttribute('d', p);
    }
    svg.append(node);
  }
  return svg;
}

// Category / folder -> icon name.
export const CATEGORY_ICON = {
  models: 'box', characters: 'user', animations: 'play', textures: 'image', materials: 'sphere', shaders: 'sparkle',
  audio: 'music', video: 'video', scenes: 'map', ui: 'layout', text: 'code', packages: 'archive', other: 'file',
};
export const FOLDER_ICON = {
  '3D_Models': 'box', '3D_Models/Characters': 'user', Animations: 'play', Textures: 'image', Materials_Shaders: 'sphere',
  Audio_Music: 'music', Videos_Cutscenes: 'video', Scenes_Maps: 'map', UI_Assets: 'layout', Scripts_Data: 'code', Other_Assets: 'archive',
};
