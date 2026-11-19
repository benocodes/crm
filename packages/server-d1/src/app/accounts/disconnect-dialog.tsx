// [[UI468]] D8 ([[UI458]]): the Disconnect confirmation, shared by the list's rows and the settings view. `onConfirm` rejects with the words to show when the delete failed (the dialog stays open).
import { ConfirmDialog } from '@vibase/ui/components'

export const DISCONNECT_BODY =
  'Vibase stops reading this mailbox and forgets its sign-in. Mail already captured stays in the CRM. You can connect it again later.'

export interface DisconnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  address: string
  /** Adds the line about another member's mailbox. */
  anotherMembers: boolean
  onConfirm: () => Promise<void>
}

export function DisconnectDialog({ open, onOpenChange, address, anotherMembers, onConfirm }: DisconnectDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Disconnect ${address}?`}
      description={DISCONNECT_BODY}
      cancelLabel="Cancel"
      confirmLabel="Disconnect"
      destructive
      onConfirm={onConfirm}
    >
      {anotherMembers ? <p className="text-sm">This is another member's mailbox.</p> : null}
    </ConfirmDialog>
  )
}
