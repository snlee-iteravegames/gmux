import type { DirectoryProbe, DirectoryProbeStatus } from '@gmux/protocol'

function externalHTTPURL(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function prTone(status: string): DirectoryProbeStatus {
  switch (status.toLowerCase()) {
    case 'open':
    case 'draft': return 'info'
    case 'merged': return 'success'
    case 'closed': return 'error'
    default: return 'neutral'
  }
}

export function folderProbeText(probe: DirectoryProbe | undefined): string[] {
  if (!probe) return []
  const items: string[] = []
  if (probe.git) {
    items.push(probe.git.branch)
    items.push(`${probe.git.dirty_count} dirty`)
  }
  if (probe.pr) items.push(`#${probe.pr.number} ${probe.pr.status}`)
  for (const script of probe.scripts ?? []) {
    items.push(`${script.label} ${script.value}`)
  }
  return items
}

function ProbeLink({
  href,
  className,
  title,
  children,
}: {
  href: string | undefined
  className: string
  title: string
  children: preact.ComponentChildren
}) {
  const safeHref = externalHTTPURL(href)
  if (!safeHref) return <span class={className} title={title}>{children}</span>
  return (
    <a
      class={className}
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={event => event.stopPropagation()}
      onAuxClick={event => event.stopPropagation()}
    >
      {children}
    </a>
  )
}

/** Compact second-line metadata shared by sidebar and project hub headings. */
export function FolderProbeMetadata({
  probe,
  className = '',
}: {
  probe: DirectoryProbe | undefined
  className?: string
}) {
  if (folderProbeText(probe).length === 0 || !probe) return null

  return (
    <div class={`folder-probe-metadata${className ? ` ${className}` : ''}`}>
      {probe.git && (
        <>
          <span class="folder-probe-item probe-git" title={`Git branch ${probe.git.branch}`}>
            {probe.git.branch}
          </span>
          <span
            class={`folder-probe-item probe-status-${probe.git.dirty_count > 0 ? 'warning' : 'success'}`}
            title={`${probe.git.dirty_count} dirty files`}
          >
            {probe.git.dirty_count} dirty
          </span>
        </>
      )}
      {probe.pr && (
        <ProbeLink
          href={probe.pr.url}
          className={`folder-probe-item folder-probe-link probe-status-${prTone(probe.pr.status)}`}
          title={`Pull request #${probe.pr.number}: ${probe.pr.status}`}
        >
          #{probe.pr.number} {probe.pr.status}
        </ProbeLink>
      )}
      {(probe.scripts ?? []).map(script => (
        <ProbeLink
          key={script.id}
          href={script.url}
          className={`folder-probe-item folder-probe-link probe-status-${script.status}`}
          title={`${script.label}: ${script.value} (${script.status})`}
        >
          {script.label} {script.value}
        </ProbeLink>
      ))}
    </div>
  )
}
