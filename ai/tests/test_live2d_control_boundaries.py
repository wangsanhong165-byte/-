"""Regression guards for the Live2D single-writer architecture."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_only_adapter_owns_model_update_and_parameter_writes():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    renderer = (ROOT / "frontend/src/character/live2d/renderer.ts").read_text(encoding="utf-8")

    assert ".setPartOpacity(" not in controllers
    assert "model.update()" not in renderer


def test_avatar_domain_events_do_not_send_model_specific_or_realtime_parameters():
    events = (ROOT / "app/avatar/events.py").read_text(encoding="utf-8")

    assert "AvatarLipSync" not in events
    assert 'preset: str = ""' not in events
    assert 'type: str = "avatar_' not in events


def test_behavior_resolver_stays_between_intent_and_live2d_controllers():
    resolver = (ROOT / "frontend/src/character/CharacterBehaviorResolver.ts").read_text(encoding="utf-8")
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")

    assert "class CharacterBehaviorResolver" in resolver
    assert ".setParameter(" not in resolver
    assert "behaviorResolver.resolve(activeIntent)" in controllers
    assert "performancePolicy.evaluate(activeIntent, basePlan" in controllers
    assert "exprCtrl.apply(policy.expression" in controllers
    assert "this.motionArbiter.request({" in controllers
    assert "name: policy.motion" in controllers
    assert "owner: `intent:${intent.turnId" in controllers
    assert "source: 'ai'" in controllers


def test_live2d_config_declares_behavior_mapping_without_parameter_ids():
    import json

    config = json.loads((ROOT / "config/live2d_models.json").read_text(encoding="utf-8"))
    mapping = config["Design_genius_White"]["behavior_map"]

    assert mapping["greet"]["motion"] == "tilt"
    assert mapping["wave"]["motion"] == "sway"
    assert mapping["agree"]["motion"] == "nod"
    assert mapping["excited"]["motion"] == "sway"
    assert "Param" not in json.dumps(mapping)


def test_runtime_client_has_no_legacy_character_action_protocol():
    client = (ROOT / "frontend/src/runtime/client.ts").read_text(encoding="utf-8")
    registry = (ROOT / "frontend/src/runtime/registry.ts").read_text(encoding="utf-8")
    assert "case 'character_action':" not in client
    assert "CharacterAction" not in registry


def test_mixer_declares_contribution_lifecycle_and_blend_modes():
    mixer = (ROOT / "frontend/src/character/ParameterMixer.ts").read_text(encoding="utf-8")

    assert "mode?: 'override' | 'add' | 'multiply'" in mixer
    assert "persistent?: boolean" in mixer
    assert "contribution.expiresAt <= now" in mixer


def test_profiles_and_policy_are_data_driven_and_do_not_write_live2d():
    import json

    profile = json.loads((ROOT / "config/avatar_profiles/Design_genius_White.json").read_text(encoding="utf-8"))
    policy = (ROOT / "frontend/src/character/CharacterPerformancePolicy.ts").read_text(encoding="utf-8")

    assert profile["parameters"]["mouth"]["open"] == "ParamMouthOpenY"
    assert "setParameter" not in policy
    assert "supportsMotion" in policy


def test_idle_behavior_respects_controller_arbitration_gate():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")

    assert "this.currentActivity === 'idle' && !this.motionArbiter.isPlaying()" in controllers


def test_pipeline_idle_does_not_cancel_an_active_presentation_motion():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    idle_case = controllers.split("case 'idle':", 1)[1].split("case 'thinking':", 1)[0]

    assert "motionArbiter.stop()" not in idle_case


def test_tts_keeps_character_speaking_until_browser_audio_ends():
    adapter = (ROOT / "frontend/src/runtime/adapter.ts").read_text(encoding="utf-8")

    tts_started = adapter.split("case 'tts.started':", 1)[1].split(
        "case 'tts.audio':", 1
    )[0]
    runtime_status = adapter.split("case 'runtime.status':", 1)[1].split(
        "case 'runtime.ready':", 1
    )[0]
    assert "runtime:tts.started" in tts_started
    assert "activity: 'idle'" not in runtime_status


def test_llm_prompt_uses_semantic_intent_not_legacy_model_controls():
    decision = (ROOT / "app/runtime/steps/decision_step.py").read_text(encoding="utf-8")
    planner = (ROOT / "app/runtime/prompt_compiler.py").read_text(encoding="utf-8")

    # PromptCompiler is the single prompt assembly boundary.
    assert "Every final segment MUST set" in planner and "{emotions}" in planner
    assert "behavior from: {behaviors}" in planner
    assert "avatar_caps = _load_avatar_capabilities()" not in decision


def test_expression_controller_keeps_settled_values_across_mixer_frames():
    controller = (ROOT / "frontend/src/character/ExpressionParameterController.ts").read_text(encoding="utf-8")

    assert "private active = new Set<string>()" in controller
    assert "const output = [...owned].map" in controller


def test_only_one_frontend_expression_parameter_controller_remains():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    explicit = (ROOT / "frontend/src/character/AvatarController.ts").read_text(encoding="utf-8")

    assert "LegacyParameterController" not in controllers
    assert "legacyExpressionTargetForBlend" not in controllers
    assert "this._ctrl.exprCtrl.apply" not in explicit
    assert "this._ctrl.motionArbiter.play" not in explicit
    assert "this._ctrl.applyAvatarExpression" in explicit
    assert "this._ctrl.applyAvatarMotion" in explicit
    assert "this._ctrl.paramCtrl.applyExpression" not in explicit


def test_backend_explicit_protocol_has_no_dormant_frame_controller():
    controller = (ROOT / "app/avatar/controller.py").read_text(encoding="utf-8")

    assert not (ROOT / "app/avatar/parameter_mixer.py").exists()
    assert not (ROOT / "app/avatar/natural_behavior.py").exists()
    assert "def update_frame(" not in controller
    assert "def set_gaze_target(" not in controller


def test_legacy_embedded_emotion_prompt_chain_is_removed():
    planner = (ROOT / "app/runtime/prompt_compiler.py").read_text(encoding="utf-8")
    preprocessor = (ROOT / "app/modules/tts_preprocessor.py").read_text(encoding="utf-8")

    assert not (ROOT / "app/prompts/utils/output_format.txt").exists()
    assert not (ROOT / "app/prompts/utils/available_emotions.txt").exists()
    assert "extract_emotion_tags" not in preprocessor
    assert "Do NOT use [keyword] tags" in planner


def test_realtime_controls_use_profile_binding_resolver():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    resolver = (ROOT / "frontend/src/character/AvatarParameterResolver.ts").read_text(encoding="utf-8")

    assert "PARAM_IDS as P" not in controllers
    assert "parameterResolver.values" in controllers
    assert "resolve(logicalParameter" in resolver
    assert "setParameter" not in resolver


def test_profiles_declare_real_parameter_bindings():
    import json

    profile = json.loads((ROOT / "config/avatar_profiles/Design_genius_White.json").read_text(encoding="utf-8"))
    assert profile["bindings"]["eye.x"] == "ParamEyeBallX"
    assert profile["bindings"]["mouth.open"] == "ParamMouthOpenY"


def test_motion_presets_use_only_logical_parameters():
    import json

    for path in (ROOT / "config/motions").glob("*.json"):
        preset = json.loads(path.read_text(encoding="utf-8"))
        assert all("Param" not in frame["parameter"] for frame in preset["keyframes"])


def test_motion_arbiter_outputs_logical_contributions_only():
    arbiter = (ROOT / "frontend/src/character/MotionArbiter.ts").read_text(encoding="utf-8")
    controller = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")

    assert "PARAM_IDS" not in arbiter
    assert "logicalParameter" in arbiter
    assert "resolveMotionDeltas" in controller


def test_sequence_metadata_cannot_bypass_executable_motion_gating():
    policy = (ROOT / "frontend/src/character/CharacterPerformancePolicy.ts").read_text(encoding="utf-8")
    profile = (ROOT / "frontend/src/character/AvatarCapabilityProfile.ts").read_text(encoding="utf-8")
    assert "supportsMotion" in policy
    assert "supportsSequence" not in policy
    assert "A profile sequence is descriptive metadata" in policy
    assert "sequences?: string[]" in profile


def test_model_expressions_preserve_cubism_blend_semantics():
    expression = (ROOT / "frontend/src/character/live2d/expression.ts").read_text(encoding="utf-8")
    manager = (ROOT / "frontend/src/character/live2d/ModelManager.ts").read_text(encoding="utf-8")
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")

    assert "blend?: 'add' | 'multiply' | 'overwrite'" in expression
    assert "normalizeExpressionBlend" in manager
    assert "expressionTargetForBlend" in controllers


def test_motion_arbiter_interpolates_and_recovers():
    arbiter = (ROOT / "frontend/src/character/MotionArbiter.ts").read_text(encoding="utf-8")

    assert "sampleMotionKeyframes" in arbiter
    assert "smoothstep" in arbiter
    assert "recoveryMs" in arbiter
    assert "frame.time <= elapsed) current.set" not in arbiter


def test_idle_uses_continuous_targets_without_random_emotions():
    idle = (ROOT / "frontend/src/character/IdleBehaviorController.ts").read_text(encoding="utf-8")

    assert "IdleBehaviorSnapshot" in idle
    assert "getSnapshot" in idle
    assert "emotion: 'happy'" not in idle
    assert "emotion: 'surprised'" not in idle


def test_pose_groups_track_one_explicit_active_member():
    pose = (ROOT / "frontend/src/character/live2d/PoseController.ts").read_text(encoding="utf-8")

    assert "activeId" in pose
    assert "select(partId: string)" in pose
    assert "getDebugState" in pose


def test_required_motion_library_is_complete_and_returns_to_rest():
    import json

    required = {
        "speak", "greet", "wave", "nod", "tilt", "sway", "shrug",
        "thinking", "react",
    }
    paths = {path.stem: path for path in (ROOT / "config/motions").glob("*.json")}
    assert required <= paths.keys()

    for name in required:
        preset = json.loads(paths[name].read_text(encoding="utf-8"))
        assert preset["duration"] > 0
        assert preset["keyframes"], f"{name} must have logical keyframes"
        assert len({frame["parameter"] for frame in preset["keyframes"]}) >= 2, (
            f"{name} must coordinate at least two body channels"
        )
        last_by_parameter = {}
        for frame in preset["keyframes"]:
            last_by_parameter[frame["parameter"]] = frame["value"]
        assert all(value == 0 for value in last_by_parameter.values()), (
            f"{name} must return every animated parameter to rest"
        )


def test_idle_transition_does_not_schedule_a_second_fixed_pose_recovery():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(
        encoding="utf-8"
    )
    profiles = (ROOT / "config/avatar_profiles").glob("*.json")

    assert "return_idle" not in controllers
    assert not (ROOT / "config/motions/return_idle.json").exists()
    for path in profiles:
        profile = json.loads(path.read_text(encoding="utf-8"))
        assert "return_idle" not in profile.get("motions", [])


def test_pet_mode_does_not_compete_with_continuous_idle_or_restart_interaction():
    pet = (ROOT / "frontend/src/character/PetModeController.ts").read_text(encoding="utf-8")

    assert "IDLE_EXPRESSION_POOL" not in pet
    assert "this._state === 'INTERACT'" in pet
    assert "behavior: 'greet'" not in pet


def test_blink_clock_and_breath_amplitude_use_natural_ranges():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")

    assert "BASE_BLINK_INTERVAL = 2.8" in controllers
    assert "breath * 8" not in controllers
    assert "this.mixer.setParams('breath', this.idleCtrl.getBreathParams())" in controllers


def test_design_tail_uses_continuous_physics_without_periodic_motion_hijack():
    profile = json.loads(
        (ROOT / "config/avatar_profiles/Design_genius_White.json").read_text(
            encoding="utf-8"
        )
    )
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(
        encoding="utf-8"
    )

    assert "idleTailMotion" not in profile
    assert "tail_sway" not in profile["motions"]
    assert not (ROOT / "config/motions/tail_sway.json").exists()
    assert profile["breathMotionGain"] >= 2
    assert "phase * 0.43" in controllers


def test_special_eye_effect_is_not_reused_for_common_positive_emotions():
    import json

    config = json.loads((ROOT / "config/live2d_models.json").read_text(encoding="utf-8"))
    mapping = config["mao_zh-Hans"]["emotion_map"]
    assert mapping["surprised"] == "exp_04"
    assert mapping["joyful"] == "exp_02"
    assert mapping["laughing"] == "exp_02"
    assert mapping["love"] == "exp_02"


def test_vite_development_uses_the_same_injected_model_configuration():
    view = (ROOT / "frontend/src/character/CharacterView.tsx").read_text(encoding="utf-8")
    vite = (ROOT / "frontend/vite.config.ts").read_text(encoding="utf-8")
    server = (ROOT / "app/bridge/server.py").read_text(encoding="utf-8")

    assert "await fetch('/api/model-info')" in view
    assert "'/api':" in vite
    assert '@app.get("/api/model-info")' in server


def test_motion_style_is_model_independent_and_bounded():
    style = (
        ROOT / "frontend/src/character/performance/MotionStyle.ts"
    ).read_text(encoding="utf-8")

    for preset in ("natural", "lively", "calm", "shy"):
        assert f"{preset}:" in style
    for option in (
        "spontaneity",
        "gestureFrequency",
        "gazeStability",
        "blinkRate",
        "breathRate",
        "breathVariance",
        "microMotionGain",
        "idleActionGain",
        "avoidRepeatWindow",
        "speechAccentGain",
    ):
        assert option in style
    assert "clamp(" in style
    assert "ParamAngle" not in style
    assert "ParamEye" not in style


def test_motion_randomness_is_seeded_per_performance_channel():
    random_source = (
        ROOT / "frontend/src/character/performance/SeededRandom.ts"
    ).read_text(encoding="utf-8")
    style = (
        ROOT / "frontend/src/character/performance/MotionStyle.ts"
    ).read_text(encoding="utf-8")

    assert "createSeededRandom" in random_source
    assert "deriveMotionSeed" in style
    assert "Math.imul" in style


def test_avatar_profiles_can_override_motion_style_and_personality():
    import json

    profile_type = (
        ROOT / "frontend/src/character/AvatarCapabilityProfile.ts"
    ).read_text(encoding="utf-8")
    assert "motionStyle?: MotionStyleOptions" in profile_type
    assert "personality?: CharacterPerformancePersonality" in profile_type
    assert "capabilities?: AvatarPerformanceCapabilities" in profile_type

    for path in (ROOT / "config/avatar_profiles").glob("*.json"):
        profile = json.loads(path.read_text(encoding="utf-8"))
        assert profile["motionStyle"]["preset"] in {
            "natural",
            "lively",
            "calm",
            "shy",
        }
        assert 0 <= profile["personality"]["expressiveness"] <= 1
        assert 0 <= profile["personality"]["softness"] <= 1
        assert 0 <= profile["personality"]["shyness"] <= 1


def test_shirone_cat_ears_and_tail_are_enabled_by_default():
    import yaml

    avatar = yaml.safe_load((ROOT / "config/avatar.yaml").read_text(encoding="utf-8"))
    cat_ears = avatar["shirone"]["components"]["猫耳"]

    assert cat_ears["expression"] == "猫耳"
    assert cat_ears["default_state"] is True


def test_body_sway_uses_targets_holds_and_focus_recentring():
    sway = (
        ROOT / "frontend/src/character/performance/BodySwayController.ts"
    ).read_text(encoding="utf-8")

    # Updated for the reworked controller: moveDuration/quinticSmoothstep/
    # recenter were replaced by the duration-based sway rework; the remaining
    # contract is target-holding + focus-level recentring.
    assert "holdUntil" in sway
    assert "pickNextTarget" in sway
    assert "focusLevel" in sway
    assert "bodyX * 0.32" in sway
    assert "bodyY * 0.42" in sway
    assert "ParamBody" not in sway


def test_idle_behavior_exposes_correlated_body_drift():
    idle = (
        ROOT / "frontend/src/character/IdleBehaviorController.ts"
    ).read_text(encoding="utf-8")
    ambient = (
        ROOT / "frontend/src/character/performance/AmbientPerformanceEngine.ts"
    ).read_text(encoding="utf-8")

    assert "BodySwayController" in idle
    assert "bodyX: number" in idle
    assert "bodyY: number" in idle
    assert "'body.x': snapshot.bodyX * gain" in ambient
    assert "'body.y': snapshot.bodyY * gain" in ambient


def test_idle_action_scheduler_is_capability_aware_and_avoids_repetition():
    scheduler = (
        ROOT / "frontend/src/character/performance/IdleActionScheduler.ts"
    ).read_text(encoding="utf-8")

    for action in (
        "small-nod",
        "head-tilt",
        "weight-shift",
        "gentle-lean",
        "sigh-sink",
        "slow-blink",
    ):
        assert f"'{action}'" in scheduler
    assert "'side-look'" not in scheduler
    assert "'curious-look'" not in scheduler
    assert "recentActions" in scheduler
    assert "recentDirections" in scheduler
    assert "capabilities" in scheduler
    assert "personality" in scheduler
    assert "buildKeyframes" in scheduler
    assert "frame(1, {})" in scheduler
    assert "ParamAngle" not in scheduler


def test_idle_actions_do_not_reenter_semantic_behavior_resolution():
    idle = (
        ROOT / "frontend/src/character/IdleBehaviorController.ts"
    ).read_text(encoding="utf-8")
    controllers = (
        ROOT / "frontend/src/character/controllers.ts"
    ).read_text(encoding="utf-8")

    assert "IdleActionScheduler" in idle
    assert "behavior: 'agree'" not in idle
    assert "activeAction" in idle
    assert "const idleIntent = this.idleBehavior.update" not in controllers


def test_speech_performance_has_onset_accents_cadence_and_release():
    speech = (
        ROOT / "frontend/src/character/performance/SpeechPerformanceController.ts"
    ).read_text(encoding="utf-8")

    assert "onsetEnvelope" in speech
    assert "accentEnvelope" in speech
    assert "releaseEnvelope" in speech
    assert "speechAccentGain" in speech
    assert "audioLevel" in speech
    assert "this.state = 'releasing'" in speech
    assert "mouth" not in speech.lower()
    assert "ParamAngle" not in speech


def test_speech_performance_coexists_with_lip_sync_and_blink():
    controllers = (
        ROOT / "frontend/src/character/controllers.ts"
    ).read_text(encoding="utf-8")
    ambient = (
        ROOT / "frontend/src/character/performance/AmbientPerformanceEngine.ts"
    ).read_text(encoding="utf-8")

    assert "SpeechPerformanceController" in ambient
    assert "this.speech.update" in ambient
    assert "ambient_performance" in controllers
    assert "this.mixer.setParams('lip_sync'" in controllers
    assert "source: 'blink'" in controllers
    assert "mode: 'multiply'" in controllers
    assert "Math.sin(t * 2.1)" not in controllers


def test_vad_state_supports_targets_stimuli_and_baseline_decay():
    vad = (
        ROOT / "frontend/src/character/performance/VADState.ts"
    ).read_text(encoding="utf-8")

    assert "valence" in vad
    assert "arousal" in vad
    assert "dominance" in vad
    assert "VAD_PRESETS" in vad
    assert "setTarget" in vad
    assert "applyStimulus" in vad
    assert "baseline" in vad
    assert "decay" in vad
    assert "Math.exp" in vad
    assert "Param" not in vad


def test_vad_is_updated_by_intent_and_visible_in_diagnostics():
    controllers = (
        ROOT / "frontend/src/character/controllers.ts"
    ).read_text(encoding="utf-8")
    events = (
        ROOT / "frontend/src/core/event-bus.ts"
    ).read_text(encoding="utf-8")

    assert "VADState" in controllers
    assert "this.vad.setEmotion" in controllers
    assert "this.vad.update(dt)" in controllers
    assert "vad:" in controllers
    assert "vad: {" in events


def test_idle_action_weighting_receives_continuous_vad():
    scheduler = (
        ROOT / "frontend/src/character/performance/IdleActionScheduler.ts"
    ).read_text(encoding="utf-8")
    idle = (
        ROOT / "frontend/src/character/IdleBehaviorController.ts"
    ).read_text(encoding="utf-8")

    assert "vad: VADVector" in scheduler
    assert "vad.valence" in scheduler
    assert "vad.arousal" in scheduler
    assert "vad.dominance" in scheduler
    assert "setVAD" in idle


def test_facs_vocabulary_is_model_independent_and_composable():
    facs = (
        ROOT / "frontend/src/character/performance/FACSState.ts"
    ).read_text(encoding="utf-8")

    for channel in (
        "browInnerUp",
        "browOuterUp",
        "eyeBlinkL",
        "eyeBlinkR",
        "eyeSquint",
        "mouthSmile",
        "mouthPucker",
        "gazeX",
        "gazeY",
        "headX",
        "headY",
        "headZ",
        "bodyX",
        "bodyY",
    ):
        assert channel in facs
    assert "addFACS" in facs
    assert "scaleFACS" in facs
    assert "facsFromVAD" in facs
    assert "Param" not in facs


def test_profile_bindings_support_range_neutral_mode_and_smoothing():
    profile = (
        ROOT / "frontend/src/character/AvatarCapabilityProfile.ts"
    ).read_text(encoding="utf-8")
    resolver = (
        ROOT / "frontend/src/character/AvatarParameterResolver.ts"
    ).read_text(encoding="utf-8")

    assert "AvatarParameterBinding" in profile
    assert "neutral?: number" in profile
    assert "scale?: number" in profile
    assert "min?: number" in profile
    assert "max?: number" in profile
    assert "mode?: 'set' | 'add' | 'subtract'" in profile
    assert "smoothing?: number" in profile
    assert "typeof binding === 'string'" in resolver
    assert "binding.neutral" in resolver
    assert "binding.scale" in resolver


def test_model_manager_catalogs_native_motion_and_expression_assets():
    manager = (
        ROOT / "frontend/src/character/live2d/ModelManager.ts"
    ).read_text(encoding="utf-8")
    profile = (
        ROOT / "frontend/src/character/AvatarCapabilityProfile.ts"
    ).read_text(encoding="utf-8")

    assert "FileReferences?.Motions" in manager
    assert "NativeMotionPlayer" in manager
    assert "getNativeMotionPlayer" in manager
    assert "motionMap?: Record<string, string>" in profile
    assert "expressionMap?: Record<string, string>" in profile


def test_native_motion_player_supports_cubism_segments_and_fades():
    player = (
        ROOT / "frontend/src/character/live2d/NativeMotionPlayer.ts"
    ).read_text(encoding="utf-8")

    assert "segmentType === 0" in player
    assert "segmentType === 1" in player
    assert "segmentType === 2" in player
    assert "segmentType === 3" in player
    assert "FadeInTime" in player
    assert "FadeOutTime" in player
    assert "parameterId" in player
    assert "setParameter(" not in player


def test_native_motion_is_authorized_by_arbiter_with_logical_fallback():
    arbiter = (
        ROOT / "frontend/src/character/MotionArbiter.ts"
    ).read_text(encoding="utf-8")
    controllers = (
        ROOT / "frontend/src/character/controllers.ts"
    ).read_text(encoding="utf-8")

    assert "setNativeMotionPlayer" in arbiter
    assert "motionMap" in arbiter
    assert "drainNativeContributions" in arbiter
    assert "nativeFallbackReason" in arbiter
    assert "this.motionArbiter.drainNativeContributions()" in controllers
    assert "channel: 'motion'" in controllers


def test_semantic_idle_stops_business_motion_when_no_native_or_preset_exists():
    arbiter = (
        ROOT / "frontend/src/character/MotionArbiter.ts"
    ).read_text(encoding="utf-8")

    idle_guard = arbiter.index("if (name === 'idle')")
    native_lookup = arbiter.index("const nativeName")
    unknown_warning = arbiter.index("Unknown motion:")
    assert native_lookup < idle_guard < unknown_warning
    assert "this.stop()" in arbiter[idle_guard:unknown_warning]


def test_profile_inspector_reports_model_assets_and_binding_coverage():
    inspector_path = ROOT / "scripts/inspect_live2d_profiles.mjs"
    assert inspector_path.exists()
    inspector = inspector_path.read_text(encoding="utf-8")
    package = (ROOT / "frontend/package.json").read_text(encoding="utf-8")

    for marker in (
        ".model3.json",
        "DisplayInfo",
        "Expressions",
        "Motions",
        "Physics",
        "Pose",
        "coverage",
        "missingBindings",
        "nativeExpressions",
        "nativeMotions",
    ):
        assert marker in inspector
    assert '"profile:inspect"' in package


def test_profile_inspector_suggests_safe_semantic_native_motion_mappings():
    inspector = (ROOT / "scripts/inspect_live2d_profiles.mjs").read_text(encoding="utf-8")

    assert "nativeMotionCatalog" in inspector
    assert "mappingSuggestions" in inspector
    assert "Talk" in inspector
    assert "speak" in inspector
    assert "Tap" in inspector
    assert "react" in inspector


def test_profile_coverage_is_visible_in_read_only_diagnostics():
    adapter = (
        ROOT / "frontend/src/character/Live2DModelAdapter.ts"
    ).read_text(encoding="utf-8")
    controllers = (
        ROOT / "frontend/src/character/controllers.ts"
    ).read_text(encoding="utf-8")
    events = (
        ROOT / "frontend/src/core/event-bus.ts"
    ).read_text(encoding="utf-8")

    assert "hasParameter" in adapter
    assert "missingBindings" in controllers
    assert "profileCoverage" in controllers
    assert "profileCoverage:" in events


def test_interaction_policy_maps_semantic_events_without_cubism_writes():
    policy_path = ROOT / "frontend/src/character/performance/InteractionPerformancePolicy.ts"
    assert policy_path.exists()
    policy = policy_path.read_text(encoding="utf-8")

    for event_type in ("touch", "drag", "inactivity", "time", "presence", "scene"):
        assert f"'{event_type}'" in policy
    assert "cooldownMs" in policy
    assert "priority" in policy
    assert "CharacterIntent" in policy
    assert "setParameter(" not in policy
    assert "ParamAngle" not in policy


def test_character_controller_consumes_unified_interaction_events():
    controllers = (
        ROOT / "frontend/src/character/controllers.ts"
    ).read_text(encoding="utf-8")
    events = (
        ROOT / "frontend/src/core/event-bus.ts"
    ).read_text(encoding="utf-8")
    view = (
        ROOT / "frontend/src/character/CharacterView.tsx"
    ).read_text(encoding="utf-8")

    assert "InteractionPerformancePolicy" in controllers
    assert "character:interaction" in controllers
    assert "'character:interaction':" in events
    assert "eventBus.emit('character:interaction'" in view


def test_last_mile_motion_style_fields_are_consumed_at_runtime():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    idle = (ROOT / "frontend/src/character/IdleBehaviorController.ts").read_text(encoding="utf-8")
    resolver = (ROOT / "frontend/src/character/AvatarParameterResolver.ts").read_text(encoding="utf-8")

    assert "setTiming(this._style.blinkRate, this._style.breathRate" in controllers
    assert "microMotionGain" in idle
    assert "gestureFrequency" in idle
    assert "setOutputGains" in resolver
    assert "parameterGain" in resolver
    assert "bodyMotionGain" in resolver


def test_ambient_performance_unifies_vad_activity_and_recovery_in_one_layer():
    ambient = ROOT / "frontend/src/character/performance/AmbientPerformanceEngine.ts"
    assert ambient.exists()
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    source = ambient.read_text(encoding="utf-8")

    assert "AmbientPerformanceEngine" in controllers
    assert "ambient_performance" in controllers
    assert "VADMicroMotionController" not in controllers
    assert "VADGestureController" not in controllers
    assert "mode: 'add'" in controllers
    assert "blockedChannels" in source
    assert "approachPose" in source


def test_private_emotion_and_voice_waiting_layers_are_profile_driven():
    profile = (ROOT / "frontend/src/character/AvatarCapabilityProfile.ts").read_text(encoding="utf-8")
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    private_overlay = ROOT / "frontend/src/character/performance/PrivateEmotionOverlay.ts"
    waiting = ROOT / "frontend/src/character/performance/VoiceWaitingMotionController.ts"

    assert "privateEmotionMap" in profile
    assert "performanceMode" in profile
    assert private_overlay.exists()
    assert waiting.exists()
    assert "PrivateEmotionOverlay" in controllers
    assert "AmbientPerformanceEngine" in controllers
    assert "VoiceWaitingMotionController" in waiting.read_text(encoding="utf-8")
    assert "private_emotion" in controllers
    assert "voice_waiting" not in controllers
    overlay = private_overlay.read_text(encoding="utf-8")
    assert "emotionIntensity" in overlay
    assert "active ? activation" in overlay
    assert "this._currentEmotionIntensity = 0" in controllers


def test_calibration_modes_and_runtime_controls_are_exposed():
    events = (ROOT / "frontend/src/core/event-bus.ts").read_text(encoding="utf-8")
    settings = (ROOT / "frontend/src/ui/SettingsPanel.tsx").read_text(encoding="utf-8")
    studio = (ROOT / "frontend/src/ui/Live2DActionStudio.tsx").read_text(encoding="utf-8")
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")

    assert "'character:performance_tuning':" in events
    assert "legacy" in controllers
    assert "enhanced" in controllers
    assert "calibration" in controllers
    assert "character:performance_tuning" in settings
    assert "mode: 'calibration'" in settings
    assert "character:action_preview" in studio


def test_legacy_mode_restores_original_micro_amplitudes_without_scaling_actions():
    idle = (ROOT / "frontend/src/character/IdleBehaviorController.ts").read_text(encoding="utf-8")
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")

    assert "setLegacy" in idle
    for original_amplitude in ("headX: 0.18", "headY: 0.12", "eyeX: 0.18", "eyeY: 0.1"):
        assert original_amplitude in idle
    assert "? 0.38" not in controllers


def test_logical_output_gain_is_bounded_by_safe_parameter_ranges():
    resolver = (ROOT / "frontend/src/character/AvatarParameterResolver.ts").read_text(encoding="utf-8")

    assert "clampLogical" in resolver
    assert "clamp(value, -1, 1)" in resolver
    assert "clamp(value, -30, 30)" in resolver
    assert "clamp(value, -15, 15)" in resolver


def test_initial_idle_starts_authored_native_idle_and_looping_motion_stays_alive():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    player = (
        ROOT / "frontend/src/character/live2d/NativeMotionPlayer.ts"
    ).read_text(encoding="utf-8")

    assert "startNativeIdleIfAvailable" in controllers
    idle_start = controllers.index("private startNativeIdleIfAvailable")
    idle_end = controllers.index("\n  }", idle_start)
    idle_block = controllers[idle_start:idle_end]
    assert "this.motionArbiter.request({" in idle_block
    assert "name: 'idle'" in idle_block
    assert "owner: 'idle:native'" in idle_block
    arbiter = (ROOT / "frontend/src/character/MotionArbiter.ts").read_text(encoding="utf-8")
    assert "this.nativeMotionChannels[name]" in arbiter
    assert "?? ['full']" in arbiter
    assert "loop: Boolean(json.Meta?.Loop)" in player
    assert "this.elapsed %= motion.duration" in player


def test_authored_native_idle_resumes_after_temporary_motion_finishes():
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")

    assert "this._wasPlaying && !this.motionArbiter.isPlaying()" in controllers
    assert "this._lastMotionEnded = true" in controllers
    assert "this.startNativeIdleIfAvailable()" in controllers
    assert "this.currentActivity === 'idle' && !this.motionArbiter.isPlaying()" in controllers


def test_model_specific_idle_mouth_baseline_only_applies_outside_speech():
    profile = (ROOT / "frontend/src/character/AvatarCapabilityProfile.ts").read_text(encoding="utf-8")
    controllers = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    mao = json.loads((ROOT / "config/avatar_profiles/mao_zh-Hans.json").read_text(encoding="utf-8"))

    assert "idleMouthOpen" in profile
    assert "idle_mouth_baseline" in controllers
    assert "this.currentActivity !== 'speaking'" in controllers
    assert mao["idleMouthOpen"] > 0


def test_live2d_defers_idle_until_browser_audio_finishes():
    source = (ROOT / "frontend/src/character/controllers.ts").read_text(encoding="utf-8")
    assert "private audioPlaybackActive = false" in source
    assert "eventBus.on('audio:start'" in source
    assert "if (activity === 'idle' && this.audioPlaybackActive)" in source


def test_idle_and_speech_share_one_smooth_activity_pose():
    source = (
        ROOT / "frontend/src/character/performance/AmbientPerformanceEngine.ts"
    ).read_text(encoding="utf-8")
    assert "if (this.activity === 'idle')" in source
    assert "else if (this.activity === 'speaking')" in source
    assert "this.current = approachPose(this.current, target, delta)" in source


def test_pet_mode_tracks_delayed_idle_timer_and_ignores_duplicate_end():
    source = (ROOT / "frontend/src/character/PetModeController.ts").read_text(encoding="utf-8")
    assert "private _resumeTimer" in source
    assert "if (this._state !== 'SPEAKING')" in source


def test_context_tags_drive_performance_policy():
    source = (ROOT / "frontend/src/character/CharacterPerformancePolicy.ts").read_text(encoding="utf-8")
    assert "contextTags.has('whisper')" in source
    assert "contextTags.has('reassuring')" in source
    assert "contextTags.has('close-up')" in source


def test_audio_decode_failure_does_not_emit_end_between_queued_segments():
    source = (ROOT / "frontend/src/audio/player.ts").read_text(encoding="utf-8")
    assert "private playbackGeneration = 0" in source
    assert "if (this.queue.length > 0)" in source
    assert "} else {\n        this.handlers.onEnd?.(item.turnId)" in source
