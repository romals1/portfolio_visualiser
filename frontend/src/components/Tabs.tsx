interface Tab {
  id: string
  label: string
}

interface Props {
  tabs: Tab[]
  active: string
  onChange: (id: string) => void
}

export default function Tabs({ tabs, active, onChange }: Props) {
  return (
    <div role="tablist" className="border-b border-gray-800 flex gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={
            active === tab.id
              ? 'px-4 py-2 text-sm font-medium text-white border-b-2 border-blue-500 -mb-px transition-colors'
              : 'px-4 py-2 text-sm font-medium text-gray-400 hover:text-gray-200 transition-colors'
          }
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
