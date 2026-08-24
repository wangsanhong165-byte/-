export type ServiceHealthRow = {
  name: string
  status: string
  detail: string
  engine: string
  model: string
  baseUrl: string
}

export function getServiceHealthRows(diagnostics: any, services: any[]): ServiceHealthRow[] {
  const rows = new Map<string, ServiceHealthRow>()
  const add = (item: any) => {
    const name = String(item?.name ?? item?.service ?? item?.id ?? '').trim()
    if (!name) return
    const current = rows.get(name)
    rows.set(name, {
      name,
      status: String(item?.status ?? current?.status ?? 'unknown'),
      detail: String(item?.detail ?? item?.adapter ?? item?.provider ?? item?.type ?? current?.detail ?? '').trim(),
      engine: String(item?.engine ?? current?.engine ?? '').trim(),
      model: String(item?.model ?? current?.model ?? '').trim(),
      baseUrl: String(item?.base_url ?? item?.baseUrl ?? current?.baseUrl ?? '').trim(),
    })
  }

  ;(diagnostics?.providers ?? []).forEach(add)
  services.forEach(add)
  return Array.from(rows.values())
}

export function formatServiceDetail(row: ServiceHealthRow | undefined): string {
  if (!row) return '运行服务'
  const engine = formatEngineName(row.engine)
  if (engine && row.model) return `${engine} · ${row.model}`
  if (row.model) return row.model
  return row.detail || '运行服务'
}

function formatEngineName(engine: string): string {
  return {
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    opencode: 'OpenCode',
    local: 'Local',
    ollama: 'Ollama',
    claude: 'Claude',
  }[engine.toLowerCase()] ?? engine
}
