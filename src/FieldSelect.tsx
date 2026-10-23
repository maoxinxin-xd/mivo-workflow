import { useId } from 'react';
import { Select } from '@douyinfe/semi-ui';
import { ChevronDown } from 'lucide-react';

export function FieldSelect({
  label,
  value,
  placeholder,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field-select-field">
      <span id={id}>{label}</span>
      <Select
        aria-labelledby={id}
        className="field-select"
        dropdownClassName="field-select-menu"
        value={value || undefined}
        placeholder={placeholder}
        optionList={options}
        disabled={disabled}
        arrowIcon={<ChevronDown size={16} strokeWidth={1.75} />}
        dropdownMatchSelectWidth
        maxHeight={240}
        zIndex={3000}
        emptyContent="暂无可选来源"
        onChange={(next) => {
          if (typeof next === 'string') onChange(next);
        }}
      />
    </div>
  );
}
