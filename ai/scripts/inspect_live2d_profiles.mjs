import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Set(process.argv.slice(2))
const valueAfter = (flag, fallback) => {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const cwd = process.cwd()
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modelsRoot = path.resolve(cwd, valueAfter('--models-root', path.join(projectRoot, 'models/live2d-models')))
const profilesRoot = path.resolve(cwd, valueAfter('--profiles-root', path.join(projectRoot, 'config/avatar_profiles')))

const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const files = await readdir(profilesRoot)
const reports = []

for (const file of files.filter(name => name.endsWith('.json'))) {
  const profile = await readJson(path.join(profilesRoot, file))
  const modelDir = path.join(modelsRoot, profile.model)
  const modelFile = path.join(modelDir, `${profile.model}.model3.json`)
  let model3
  try { model3 = await readJson(modelFile) } catch { continue }

  const refs = model3.FileReferences ?? {}
  const displayInfoFile = refs.DisplayInfo ? path.join(modelDir, refs.DisplayInfo) : null
  let knownParameters = new Set()
  let displayParameters = []
  if (displayInfoFile) {
    try {
      const display = await readJson(displayInfoFile)
      const groupNames = new Map((display.ParameterGroups ?? []).map(group => [group.Id, group.Name]))
      displayParameters = (display.Parameters ?? []).map(parameter => ({
        id: parameter.Id,
        name: parameter.Name ?? '',
        group: groupNames.get(parameter.GroupId) ?? '',
      }))
      knownParameters = new Set(displayParameters.map(parameter => parameter.id))
    } catch { /* DisplayInfo is optional. */ }
  }

  const bindings = Object.entries(profile.bindings ?? {}).map(([logical, binding]) => ({
    logical,
    target: typeof binding === 'string' ? binding : binding.target,
  }))
  const boundLogicalParameters = new Set(bindings.map(binding => binding.logical))
  const logicalMotionIssues = []
  for (const preset of profile.logicalMotionPresets ?? []) {
    for (const keyframe of preset.keyframes ?? []) {
      if (!boundLogicalParameters.has(keyframe.parameter)) {
        logicalMotionIssues.push(`${preset.name}: missing binding for ${keyframe.parameter}`)
      }
    }
  }
  const missingBindings = knownParameters.size
    ? bindings.filter(binding => !knownParameters.has(binding.target))
    : []
  const validBindings = bindings.length - missingBindings.length
  const nativeExpressions = (refs.Expressions ?? []).map(item => item.Name)
  const nativeMotionCatalog = Object.entries(refs.Motions ?? {}).flatMap(([group, items]) =>
    items.map((item, index) => ({
      group,
      index,
      name: item.Name ?? `${group}:${index}`,
      file: item.File,
      basename: item.File ? path.basename(item.File).replace(/\.motion3\.json$/i, '') : undefined,
    })),
  )
  const nativeMotions = nativeMotionCatalog.map(item => item.name)
  const nativeMotionAliases = new Set(nativeMotionCatalog.flatMap(item => [
    item.name?.toLowerCase(),
    item.group?.toLowerCase(),
    item.basename?.toLowerCase(),
  ]).filter(Boolean))
  const logicalMotionNames = new Set((profile.logicalMotionPresets ?? [])
    .map(preset => String(preset.name ?? '').toLowerCase())
    .filter(Boolean))
  const declaredMotionNames = new Set([
    ...(profile.motions ?? []).map(name => String(name).toLowerCase()),
    ...logicalMotionNames,
    ...nativeMotionAliases,
  ])
  const invalidMotionMappings = Object.entries(profile.motionMap ?? {})
    .filter(([, target]) => !nativeMotionAliases.has(String(target).toLowerCase()))
    .map(([semantic, target]) => ({ semantic, target }))
  const invalidSemanticMotionMappings = Object.entries(profile.semanticMotionMap ?? {})
    .filter(([, target]) => !declaredMotionNames.has(String(target).toLowerCase()))
    .map(([semantic, target]) => ({ semantic, target }))
  const logicalCapabilities = {
    headControl: ['head.x', 'head.y', 'head.z'],
    bodyControl: ['body.x', 'body.y'],
    gazeControl: ['eye.x', 'eye.y'],
    eyeBlink: ['blink.left', 'blink.right'],
    mouthControl: ['mouth.open'],
    mouthForm: ['mouth.form'],
    breathControl: ['breath'],
  }
  const capabilityGaps = Object.entries(logicalCapabilities).flatMap(([capability, logicalKeys]) => {
    if (profile.capabilities?.[capability] === false) return []
    const missing = logicalKeys.filter(logical => !bindings.some(binding => binding.logical === logical))
    return missing.length ? [{ capability, missing }] : []
  })
  const lipSyncIssues = []
  if (profile.lipSync) {
    if (!bindings.some(binding => binding.logical === 'mouth.open')) {
      lipSyncIssues.push('lipSync configured without mouth.open binding')
    }
    if (Number(profile.lipSync.min ?? 0) < 0
      || Number(profile.lipSync.max ?? 1) > 1
      || Number(profile.lipSync.min ?? 0) > Number(profile.lipSync.max ?? 1)) {
      lipSyncIssues.push('lipSync min/max must satisfy 0 <= min <= max <= 1')
    }
  }
  const profileIssues = []
  const tailParameters = displayParameters.filter(parameter => /尾|tail|尻|しっぽ/i.test(`${parameter.name} ${parameter.group}`))
  const armParameters = displayParameters.filter(parameter => /手|臂|arm/i.test(`${parameter.name} ${parameter.group}`))
  let tailPhysicsInputs = []
  if (refs.Physics && tailParameters.length) {
    try {
      const physics = await readJson(path.join(modelDir, refs.Physics))
      const tailIds = new Set(tailParameters.map(parameter => parameter.id))
      tailPhysicsInputs = [...new Set((physics.PhysicsSettings ?? []).flatMap(setting =>
        (setting.Output ?? []).some(output => tailIds.has(output.Destination?.Id))
          ? (setting.Input ?? []).map(input => input.Source?.Id).filter(Boolean)
          : [],
      ))]
    } catch { /* Physics diagnostics remain optional. */ }
  }
  if (profile.idleTailMotion?.enabled && tailParameters.length === 0) {
    profileIssues.push('idleTailMotion enabled but DisplayInfo has no tail parameter group')
  }
  if (profile.idleTailMotion?.enabled && tailParameters.length > 0 && tailPhysicsInputs.length === 0) {
    profileIssues.push('idleTailMotion enabled but no physics input drives the named tail parameters')
  }
  const motionStylePreset = profile.motionStyle?.preset
  if (motionStylePreset && !['natural', 'lively', 'calm', 'shy'].includes(motionStylePreset)) {
    profileIssues.push(`unknown motionStyle preset: ${motionStylePreset}`)
  }
  const idleMotionIssues = []
  const idleTarget = profile.motionMap?.idle
  if (idleTarget) {
    const normalizedTarget = String(idleTarget).toLowerCase()
    const idleEntry = nativeMotionCatalog.find(item => [item.name, item.group, item.basename]
      .filter(Boolean)
      .some(alias => String(alias).toLowerCase() === normalizedTarget))
    if (idleEntry?.file) {
      try {
        const motion = await readJson(path.join(modelDir, idleEntry.file))
        const parameterIds = (motion.Curves ?? [])
          .filter(curve => curve.Target === 'Parameter' && typeof curve.Id === 'string')
          .map(curve => curve.Id)
        const naturalChannels = parameterIds.filter(id => /^(ParamAngle|ParamBodyAngle|ParamBreath)/i.test(id))
        const idleChannels = profile.nativeMotionChannels?.idle ?? []
        const intentionallySecondary = idleChannels.includes('secondary')
          || idleChannels.includes('accessory')
        if (parameterIds.length > 0 && naturalChannels.length === 0 && !intentionallySecondary) {
          idleMotionIssues.push(`idle motion ${idleEntry.file} has effect/expression parameters only: ${parameterIds.join(', ')}`)
        }
      } catch (error) {
        idleMotionIssues.push(`idle motion could not be inspected: ${idleEntry.file}`)
      }
    }
  }
  const semanticGroups = { Talk: 'speak', Tap: 'react', Idle: 'idle' }
  const mappingSuggestions = Object.fromEntries(
    Object.entries(semanticGroups)
      .filter(([group]) => nativeMotionCatalog.some(item => item.group.toLowerCase() === group.toLowerCase()))
      .map(([group, semantic]) => [semantic, group]),
  )

  reports.push({
    model: profile.model,
    profile: file,
    coverage: bindings.length ? validBindings / bindings.length : 1,
    bindingCount: bindings.length,
    validBindings,
    missingBindings,
    capabilityGaps,
    invalidMotionMappings,
    invalidSemanticMotionMappings,
    logicalMotionIssues,
    lipSyncIssues,
    profileIssues,
    idleMotionIssues,
    nativeExpressions,
    nativeMotions,
    nativeMotionCatalog,
    mappingSuggestions,
    namedCapabilities: {
      tail: {
        parameterCount: tailParameters.length,
        parameters: tailParameters,
        physicsInputs: tailPhysicsInputs,
      },
      arm: {
        parameterCount: armParameters.length,
        parameters: armParameters,
      },
    },
    assets: {
      DisplayInfo: Boolean(refs.DisplayInfo),
      Expressions: nativeExpressions.length,
      Motions: nativeMotions.length,
      Physics: Boolean(refs.Physics),
      Pose: Boolean(refs.Pose),
    },
  })
}

if (args.has('--json')) {
  console.log(JSON.stringify(reports, null, 2))
} else {
  for (const report of reports) {
    console.log(`${report.model}: ${(report.coverage * 100).toFixed(1)}% bindings, ${report.nativeExpressions.length} expressions, ${report.nativeMotions.length} motions`)
    for (const missing of report.missingBindings) console.log(`  missing ${missing.logical} -> ${missing.target}`)
  }
}

if (args.has('--strict') && reports.some(report =>
  report.missingBindings.length > 0
  || report.capabilityGaps.length > 0
  || report.invalidMotionMappings.length > 0
  || report.invalidSemanticMotionMappings.length > 0
  || report.logicalMotionIssues.length > 0
  || report.lipSyncIssues.length > 0
  || report.profileIssues.length > 0
  || report.idleMotionIssues.length > 0)) {
  process.exitCode = 1
}
