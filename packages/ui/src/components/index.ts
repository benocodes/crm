// `@vibase/ui/components` ([[UI445]] D7): the shadcn primitives (namespace `ui`) and the Vibase composites with [[UI254]] D6's contract.
export * as ui from './ui'
export { Alert, type AlertProps, type AlertVariant } from './alert'
export { Button, type ButtonProps, type ButtonVariant } from './button'
export { Card, type CardProps } from './card'
export { CodeInput, DEFAULT_GROUP_LENGTH, normaliseCode, type CodeInputProps } from './code-input'
export { Field, type FieldProps } from './field'
export { FormLayout, type FormLayoutProps, type SubmitResult } from './form-layout'
export { ScopeList, type ScopeItem } from './scope-list'
// [[UI443]] D11: the settings layout the workspace app's pages compose.
export { AppShell, type AppNavEntry, type AppNavLinkProps, type AppShellProps } from './app-shell'
export { CommandBlock, type CommandBlockProps } from './command-block'
export { PromptCard, type PromptAction, type PromptCardProps } from './prompt-card'
export { SettingsPage, type SettingsPageProps } from './settings-page'
export { SettingsRow, type SettingsRowProps } from './settings-row'
export { SettingsSection, type SettingsSectionProps } from './settings-section'
// [[UI458]] D11: the list, dialog and form composites the Connected accounts and Agents pages compose.
export { ChoiceGroup, type ChoiceGroupProps, type ChoiceOption } from './choice-group'
export { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog'
export { ListEditor, type ListEditorProps } from './list-editor'
export {
  ResourceList,
  type ResourceListItem,
  type ResourceListProps,
  type ResourceRowAction,
} from './resource-list'
export { StatusBadge, type StatusBadgeProps, type StatusTone } from './status-badge'
