<div align="center">

# Aurora

### A local AI companion that lives on your desktop

**Speaks · Expresses · Remembers · Configurable · Local-first**

Aurora is a Windows desktop AI companion project that brings real-time voice, LLM conversation, Live2D embodiment, persistent memory, character persona, and proactive behavior into one observable runtime pipeline.

<p>
  <a href="ai/">Open the project directory</a> ·
  <a href="ai/README.md">Chinese documentation</a> ·
  <a href="README.md">中文</a>
</p>

</div>

---

## What is Aurora?

Aurora is more than a text chat window and more than a demo that glues audio, models, and animation together. Its goal is to give an AI character four properties at once: understanding, expression, memory, and presence.

Users can type or speak through a microphone. The system performs speech recognition, context assembly, memory retrieval, model inference, tool execution, character-intent interpretation, and speech synthesis, then sends the result to a desktop client for voice, lip sync, expressions, and motion.

The repository is useful for three audiences: people who want a local desktop companion; developers studying voice, memory, and Live2D coordination; and engineers experimenting with persona, proactive behavior, and multi-model configuration in a real runtime.

## Why it is different from a normal chatbot

| Dimension | Typical chat window | Aurora’s direction |
|---|---|---|
| Interaction | Text messages are the center | Text, voice, audio, expressions, and motion work together |
| Character | Usually an invisible interface | A Live2D avatar with voice, persona, and state |
| Context | Mostly the current session | History, long-term memory, character state, and relationship context |
| Output | A generated text response | A response that can be read, heard, and performed |
| Deployment | Often a remote service | Local-first services with a configurable local or compatible LLM |
| Lifecycle | A process is considered enough | Dependencies, readiness, warmup, identity, and clean shutdown matter |

## Core capabilities

### 1. A complete real-time voice pipeline

Voice interaction is a continuous pipeline rather than a recording button: VAD detects speech boundaries, ASR transcribes audio, the Runtime assembles the turn, the LLM generates a response, TTS produces audio, and the desktop client synchronizes playback with the avatar.

```text
Microphone
    ↓
VAD: detect speech boundaries
    ↓
ASR: speech recognition
    ↓
Character Runtime: context, memory, persona, tools, and turn decisions
    ↓
LLM: generate the character response
    ↓
TTS / GPT-SoVITS: synthesize the voice
    ↓
Electron + Live2D: playback, lip sync, and performance control
```

Text mode remains available, so conversation, memory, tool, and persona logic can be tested without loading the full voice stack.

### 2. An embodied Live2D character

The frontend does more than draw a model on a canvas. Semantic `character.intent` events are translated into posture, expression, motion, gaze, lip sync, and ambient behavior, then written through a coordinated parameter path into Cubism.

```text
CharacterBehaviorResolver
        ↓
CharacterPerformancePolicy
        ↓
PerformanceCoordinator / MotionArbiter
        ↓
ParameterMixer
        ↓
Live2DModelAdapter
        ↓
Cubism Web Framework + WebGL
```

Speech playback, emotion, user interaction, and idle behavior can share the same performance coordination layer instead of competing through unrelated parameter writers.

### 3. Persistent memory that can evolve

The memory subsystem is more than a chat transcript. It includes history storage, extraction, retrieval, compilation, review, and lifecycle management, using SQLite and FTS5 for local search, plus temporal semantics (time anchors / expiry) and a local small-model vector channel (Qwen3-Embedding-0.6B for embedding recall, Qwen3-Reranker-0.6B for cross-encoder reranking), along with conflict arbitration and weekly reflection.

Retrieved memories can participate in later context assembly, allowing the character to build continuity around the user, preferences, and relationship instead of only remembering the previous message. The active policy is defined by `ai/app/memory/` and the current configuration.

### 4. Persona and proactive behavior

Runtime V3 treats an interaction as a structured turn rather than a simple “input string → output string” function. The turn pipeline handles the character self, context budgets, intent, tool policy, response validation, voice routing, performance semantics, and turn recording.

The repository also contains initiative, initiative-memory, and scheduler modules that provide foundations for idle detection, proactive care, and more continuous character behavior. Whether proactive behavior is enabled depends on the current configuration and runtime state.

### 5. Composable models, characters, and voices

Live2D assets, character definitions, and voices are managed separately. Changing a character does not require copying the backend; a model, voice, and persona configuration can be combined through the character and avatar configuration directories.

The repository currently contains these Live2D model resources:

- `Design_genius_White`
- `ariu`
- `hiyori_zh-Hans`
- `mao_zh-Hans`
- `youxiaomiao`
- `shirone`

The character configurations include `alice`, `jingyu`, and `monika`; the voice directory contains three voice packs (`alims`, `amiya`, `monika`). Models, voices, and third-party assets may have separate licenses; verify permissions before redistributing them.

### 6. A diagnosable local service lifecycle

`soulctl.cmd` is the official Windows source entry point. The Python Lifecycle Supervisor owns service dependencies, startup order, readiness, model warmup, port state, process identity, recovery, and shutdown.

This means that “the process exists” or “the HTTP port responds” is not treated as proof that a service is ready. Voice mode waits for the relevant models to load and warm up, while the desktop client uses capability state before entering the full character UI.

## Service architecture

The source of truth is [`ai/config/services.json`](ai/config/services.json). Ports can be dynamically assigned with fallbacks, so this overview describes responsibilities rather than hard-coding port numbers.

| Service | Responsibility | Dependency / behavior |
|---|---|---|
| `llm` | Text understanding and generation | OpenAI-compatible interface; local or compatible provider |
| `bridge` | HTTP / WebSocket connection between backend and client | Connects Runtime, Electron, and frontend capabilities |
| `gsvi` | GPT-SoVITS voice-model service | Provides model-level voice capability; isolated failure policy |
| `tts` | Unified speech-synthesis API | Depends on the voice model service and supports warmup |
| `asr` | Speech-recognition service | Transcribes microphone input in the voice pipeline |
| `frontend` | Vite development interface | Started by the full development profile |

Services are combined through profiles. Text and voice capabilities have different readiness requirements, so the launcher manages the required set instead of blindly starting every process.

## What happens during one turn

```text
1. The user types or speaks
2. Bridge / CLI sends the input to Character Runtime
3. Runtime loads character config, history, memory, and current state
4. Context Assembler builds the turn context and enforces the budget
5. The LLM responds; tool confirmation and execution may occur
6. Response Interpreter / Validator parses the response and intent
7. TTS generates audio and TransportEmitter publishes runtime events
8. Electron updates subtitles, playback, lip sync, expressions, and motion
9. Turn Recorder and Memory store the turn for later retrieval
```

Runtime Protocol V3 defines the envelope, event catalog, and production boundaries. See [`ai/docs/runtime/V3_PROTOCOL.md`](ai/docs/runtime/V3_PROTOCOL.md).

## Quick start

### Requirements

- Windows 10 / 11
- Python 3.10 or newer, plus the project’s local environment
- Node.js and npm for the Electron / Vite frontend
- A microphone and audio output device for voice mode
- The relevant ASR, TTS, Live2D, and LLM assets or service configuration

Large model weights and local runtime data are not always suitable for Git. Prepare the model environment according to `ai/config/`, the project documentation, and your own local model directories.

### Recommended launcher

```powershell
cd "ai"

# Check interpreters, configuration, and service endpoints
.\soulctl.cmd doctor

# Start services and open the Electron desktop client
.\soulctl.cmd electron
```

Development mode with Vite hot reload:

```powershell
cd "ai"
.\soulctl.cmd electron --hot
```

Start only the backend and print the Bridge address:

```powershell
cd "ai"
.\soulctl.cmd web
```

Inspect, restart, or stop services:

```powershell
.\soulctl.cmd status
.\soulctl.cmd restart
.\soulctl.cmd stop
```

Diagnostics:

```powershell
.\soulctl.cmd diagnostics
```

### Lightweight text mode

To validate the text path without the complete voice stack:

```powershell
python run.py --text
```

See [`ai/docs/runtime/LAUNCH_ARCHITECTURE.md`](ai/docs/runtime/LAUNCH_ARCHITECTURE.md) for profiles, readiness, and shutdown behavior.

## Where to configure the project

| Path | Purpose |
|---|---|
| `ai/config/services.json` | Service manifest, profiles, dependencies, readiness, and launch arguments |
| `ai/config/characters/` | Character cards, personas, and character-level settings |
| `ai/config/avatar_profiles/` | Live2D model capabilities and performance settings |
| `ai/config/voices/` | Voice resources and voice configuration |
| `ai/config/.env` | Local keys, endpoints, and environment variables; never commit it |
| `ai/config/runtime.local.json` | Local runtime overrides; never commit it |
| `ai/config/mcp_servers.json` | MCP server configuration when enabled locally |
| `ai/frontend/src/` | React, session, Live2D, and desktop UI implementation |

Configuration precedence and field details are defined by the implementation and `services.json`. Do not commit API keys, model weights, personal memory databases, or generated runtime state.

## Frontend and desktop client

The frontend uses React, TypeScript, Vite, and Electron. `ai/frontend/src/` is organized around character rendering, sessions, conversations, runtime transport, settings, and UI surfaces. Electron owns desktop windows, startup readiness, asset selection, and client bridging.

The frontend is not the only source of service state. The bootstrap and Electron layers read lifecycle status from the backend and distinguish an opened window from a genuinely ready voice capability.

## Testing and verification

Run backend tests from `ai`:

```powershell
cd "ai"
python -m pytest -p no:cacheprovider -q
```

Run frontend checks from `ai/frontend`:

```powershell
cd "ai/frontend"
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Live2D changes cannot be accepted from compilation alone. Validate them with real models, actual playback, and concrete interaction scenarios, including lip sync, motion arbitration, parameter ownership, window lifecycle, and service shutdown.

## Repository map

```text
.
└─ ai/
   ├─ app/
   │  ├─ lifecycle/       Supervisor, health, readiness, and shutdown
   │  ├─ runtime/         Runtime V3 turns, context, intent, and tools
   │  ├─ memory/          Extraction, retrieval, compilation, review, storage
   │  ├─ bridge/           HTTP / WebSocket Bridge
   │  ├─ modules/          ASR, LLM, TTS, MCP, and service modules
   │  ├─ providers/        External capability adapters
   │  └─ transport/        Event publication and session transport
   ├─ config/
   │  ├─ services.json     Lifecycle source of truth
   │  ├─ characters/       Alice, Monika, and other character config
   │  ├─ avatar_profiles/  Live2D performance profiles
   │  └─ voices/           Voice configuration
   ├─ contracts/v3/        Runtime Protocol V3 contracts
   ├─ frontend/             React, Electron, Live2D, and UI
   ├─ models/               ASR, TTS, Live2D, and local assets
   ├─ scripts/              Launcher, diagnostics, and development tools
   ├─ tests/                Python, lifecycle, and protocol tests
   ├─ docs/                 Current architecture and historical materials
   ├─ soulctl.cmd           Windows launcher
   ├─ run.py                CLI compatibility entry point
   ├─ README.md             Chinese project documentation
   └─ ARCHITECTURE.md       Runtime V3 architecture
```

## Documentation map

- [Chinese project guide](ai/README.md): quick start, capabilities, stack, and daily entry points
- [Architecture overview](ai/ARCHITECTURE.md): layers, lifecycle, Runtime V3, transport, Live2D, and memory boundaries
- [Launch architecture](ai/docs/runtime/LAUNCH_ARCHITECTURE.md): Supervisor, profiles, readiness, and shutdown
- [Runtime Protocol V3](ai/docs/runtime/V3_PROTOCOL.md): envelope, events, and production path
- [Documentation index](ai/docs/README.md): how to distinguish current and historical materials

Audit reports, plans, and archived documents are historical references and may not describe current behavior. When documentation and code disagree, inspect `services.json`, lifecycle code, Runtime, frontend implementation, and tests first.

## Project status and boundaries

Aurora is an evolving personal and experimental desktop AI project. Its value is in connecting systems that are usually separate into a runnable, diagnosable, and extensible character-interaction pipeline—not in promising that every machine will work out of the box.

GPU drivers, Python environments, model weights, audio devices, and LLM providers affect startup time and available capabilities. Third-party Live2D and voice assets may also have independent copyright and usage restrictions.

Start with this page for the project concept, enter [`ai/`](ai/) to run it, and read [`ai/ARCHITECTURE.md`](ai/ARCHITECTURE.md) to understand implementation boundaries.

<div align="center">

**An AI that does not only answer you—it shows up in front of you.**

</div>
