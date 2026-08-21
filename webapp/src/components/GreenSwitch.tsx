type Props = {
  on: boolean
  onChange: (next: boolean) => void
  title?: string
  disabled?: boolean
}

/** Compact green on/off switch (replaces checkbox / Off·On tick pairs). */
export function GreenSwitch({ on, onChange, title, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={`sw-green${on ? ' on' : ''}`}
      title={title ?? (on ? 'On' : 'Off')}
      onClick={() => onChange(!on)}
    >
      <span className="sw-knob" />
    </button>
  )
}
