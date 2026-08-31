# 前端设置整合方案（已完成，2026-08 实施）

> **状态：已实施**。模型选择已迁入 Settings → Live2D 工作台 hero card（AnimationTab），General tab 的 Live2D Model 下拉与 Character 死下拉已移除。本文保留为设计记录。

> 范围收敛(按用户指示):只整合「模型选择」进 Live2D 工作台 + 移除 Character 死下拉。**其他不改**(Appearance tab、Accessories、Window、Interaction 全部保留)。

## 改动点 1:模型选择整合到 Live2D 工作台

**目标**:Settings → General 的「Live2D Model」下拉移除;Live2D 工作台 hero card 的「当前模型:xxx」(只显示)改为可选模型。

### 1a. SettingsPanel.tsx GeneralTab — 移除 Live2D Model 下拉
- 位置:`ui/SettingsPanel.tsx` 的 `GeneralTab`,约 195-205 行(`<SettingRow label="Live2D Model">...</SettingRow>`)
- 删除:整个 `SettingRow label="Live2D Model"` 块
- 删除:`models` state + `useEffect`(fetch `/api/models`)(约 168-177 行)——这个 fetch 逻辑**移到 AnimationTab**
- 保留:Character 下拉(待 1b 移除)、Window、Interaction

### 1b. SettingsPanel.tsx AnimationTab — hero card 改可选模型
- 位置:`ui/SettingsPanel.tsx` 的 `AnimationTab`(Live2D 表现工作台),hero card 约 336-344 行
- 改:「当前模型:{settings.live2dModel}」→ 模型选择 `<select>`(value=`settings.live2dModel`,onChange=`onSettingChange('live2dModel', ...)`)
- 加:模型列表 state + fetch `/api/models`(从 GeneralTab 移过来的逻辑)
- 保留:hero card 的标题「Live2D 表现工作台」+「模型独立配置」徽章

## 改动点 2:移除 General 的 Character 下拉(死控件)

**位置**:`ui/SettingsPanel.tsx` GeneralTab:
- 删除:183-193 行 `<SettingRow label="Character">...</SettingRow>`(select)
- 删除:167 行 `const characters = [{ id: settings.activeCharacterId, label: settings.activeCharacterId }]`
- 角色切换仍通过「角色库」面板(已有切换按钮)完成,Settings 不再重复放角色下拉

## 不改的部分

- Settings → Appearance tab + Accessories 配件开关(保留原样)
- Settings → General 的 Window / Interaction 部分(保留)
- Settings → About tab(保留)
- `CompanionWorkspace.tsx`(无 props 变化——模型选择用 `settings.live2dModel` / `onSettingChange`,已具备)

## 验证

1. 前端 157 测试:`cd frontend && npm test`
2. TS 类型检查:`npx tsc --noEmit`
3. Vite 构建:`npm run build`
4. 内置浏览器:Settings General 无「Live2D Model」下拉;Live2D 工作台 hero card 可切换模型

## 涉及文件

- `frontend/src/ui/SettingsPanel.tsx`(唯一文件,GeneralTab + AnimationTab)
