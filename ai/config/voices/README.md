# 音色（Voice Pack）放置规范

本目录 `config/voices/<voice_id>/` 是音色的唯一正确位置。运行时 `VoiceRegistry.resolve(voice_id)` 只认这里，字段与文件名必须一字不差，否则静默回退默认权重（表现为角色声音变成别人的）。

## 目录结构（三个现有音色即标准示例）

config/voices/alims/
  voice.json                 # 元数据（必填）
  Aemeath.wav                # 参考音频（ref 字段指向）
  Aemeath-e15.ckpt           # GPT 权重（gpt 字段指向）
  Aemeath_e8_s272.pth        # SoVITS 权重（vits 字段指向）

config/voices/amiya/  （同构）
config/voices/monika/ （同构）

## voice.json 字段

{
  "id": "alims",                    // 与目录名一致，小写
  "name": "Alims",                  // 显示名
  "ref": "Aemeath.wav",             // 参考音频，相对本目录
  "gpt": "Aemeath-e15.ckpt",        // GPT 权重，相对本目录
  "vits": "Aemeath_e8_s272.pth",    // SoVITS 权重，相对本目录
  "prompt_text": "看！雪融爆爆限量款蛋糕……",  // 参考音频的逐字转写，必须与音频内容一致
  "prompt_lang": "zh"               // 转写语言：zh/en/ja/ko/yue
}

## 添加新声音的标准流程

1. 建目录：`config/voices/<新id>/`（新id=小写字母数字下划线）
2. 放入三个文件：
   - 参考音频 `ref.wav`（10-30 秒、无背景音乐、口齿清晰的干声）
   - GPT 权重 `xxx.ckpt`
   - SoVITS 权重 `yyy.pth`
3. 写 `voice.json`（按上面模板，字段文件名必须与实际完全一致）
4. 关键：`prompt_text` 必须是你参考音频的逐字转写，语言要匹配——转写错了或为空，合成会出现电音/含混
5. 角色卡引用：在 `config/characters/<角色>/character.json` 的 `tts.voice_id` 填新 id
6. 验证：重启后切到该角色说一句，或跑
   `python -c "from app.character.voices import VoiceRegistry; from pathlib import Path; print(VoiceRegistry(Path.cwd()).resolve('<新id>'))"`
   确认 gpt/vits/ref 三条路径都 exists=True

## 注意事项

- 权重文件较大（ckpt~150MB / pth~130MB），已被 .gitignore 忽略，不提交 git；换机器需手动放回
- 架构匹配：v2Pro 权重（文件头 05）与 v2ProPlus（06）均可被同一服务动态加载（api 按文件头自动识别），无需改 yaml
- `tts_infer.yaml` 的 custom 段只是服务启动默认音色，运行时切角色会通过 /set_gpt_weights + /set_sovits_weights 动态切换，不用手工改 yaml
