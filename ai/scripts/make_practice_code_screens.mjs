import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, '_runs', 'output', 'playwright');
await mkdir(out, { recursive: true });

const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const lines = (value) => value.split(/\r?\n/).map((line, i) => `<span class="line"><b>${String(i + 1).padStart(3, ' ')}</b>${escape(line)}</span>`).join('');
const page = (title, subtitle, body) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#10131a;color:#e8edf5;font-family:Segoe UI,Microsoft YaHei,sans-serif}header{padding:28px 42px;background:#18202d;border-bottom:1px solid #334155}h1{margin:0 0 8px;font-size:28px}p{margin:0;color:#9fb0c7;font-size:15px}.card{margin:28px 42px;background:#0b0f15;border:1px solid #2d3b50;border-radius:12px;overflow:hidden}.path{padding:14px 20px;color:#7dd3fc;background:#172235;font-weight:600}.code{padding:18px 0;font:14px/1.55 Consolas,\"Cascadia Code\",monospace;white-space:pre}.line{display:block;padding:0 24px}.line:hover{background:#162033}.line b{display:inline-block;width:38px;margin-right:18px;color:#52657e;font-weight:400} </style><header><h1>${title}</h1><p>${subtitle}</p></header>${body}`;
const codeCard = async (file, label, maxLines = 100) => { const text = await readFile(path.join(root, file), 'utf8'); return `<section class="card"><div class="path">${label} · ${file}</div><div class="code">${lines(text.split(/\r?\n/).slice(0, maxLines).join('\n'))}</div></section>`; };
const tree = `ai/\n├─ app/\n│  ├─ lifecycle/\n│  ├─ modules/\n│  │  ├─ asr/\n│  │  └─ tts/\n│  ├─ avatar/\n│  └─ domain/character/\n├─ frontend/\n│  └─ src/\n│     ├─ character/\n│     ├─ runtime/\n│     ├─ session/\n│     └─ audio/\n├─ electron/\n├─ config/\n├─ contracts/\n├─ scripts/\n├─ tests/\n├─ soulctl.cmd\n└─ README.md`;
await writeFile(path.join(out, '04_项目工程结构与核心代码.html'), page('项目工程结构与核心代码', '真实项目目录结构与前端角色控制入口', `<section class="card"><div class="path">C:\\Users\\LENOVO\\Desktop\\c++\\ai</div><div class="code">${lines(tree)}</div></section>`));
await writeFile(path.join(out, '05_AI与语音模块开发.html'), page('AI 与语音模块开发', '真实后端 TTS 接口模块源码', await codeCard('app/modules/tts/api.py', 'TTS API', 120)));
await writeFile(path.join(out, '06_Live2D角色表现控制开发.html'), page('Live2D 角色表现控制开发', '真实前端参数混合与动作仲裁源码', (await codeCard('frontend/src/character/ParameterMixer.ts', 'ParameterMixer', 120)) + (await codeCard('frontend/src/character/MotionArbiter.ts', 'MotionArbiter', 80))));
await writeFile(path.join(out, '08_系统性能优化与问题排查.html'), page('系统性能优化与问题排查', '真实 Live2D 性能策略与协调测试源码', await codeCard('frontend/src/character/performance-policy.ts', 'PerformancePolicy', 120)));
