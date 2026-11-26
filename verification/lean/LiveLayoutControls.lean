import Lean

/-!
Executable control policy for the Live detail design pilot.
Run with `lean --run verification/lean/LiveLayoutControls.lean` (Lean 4.24.0).

The policy covers ordinary, settled MoQ channels with a copyable plan and an
assigned encoding. STOPPED denotes a clean terminal run. RUNNING denotes a
fresh, active run. The role and run phase are fixed during history inspection.
The browser tests compare the exported action IDs with rendered controls and
check layout separately.
-/

namespace BitOVP.LiveLayoutControls

set_option autoImplicit false

inductive Role where
  | operator
  | viewer
  deriving DecidableEq

inductive Phase where
  | stopped
  | running
  deriving DecidableEq

inductive Action where
  | startNew
  | copySettings
  | stop
  | restart
  deriving DecidableEq

structure DetailView where
  role : Role
  phase : Phase
  historyOpen : Bool

def DetailView.actions (view : DetailView) : List Action :=
  match view.role, view.phase with
  | .viewer, _ => []
  | .operator, .stopped => [.startNew, .copySettings]
  | .operator, .running => [.stop, .restart, .copySettings]

def Action.permittedIn (action : Action) (view : DetailView) : Prop :=
  view.role = .operator ∧
    match action with
    | .startNew => view.phase = .stopped
    | .copySettings => True
    | .stop => view.phase = .running
    | .restart => view.phase = .running

theorem actionsMatchPolicy (view : DetailView) (action : Action) :
    action ∈ view.actions ↔ action.permittedIn view := by
  rcases view with ⟨role, phase, historyOpen⟩
  cases role <;> cases phase <;> cases action <;>
    simp [DetailView.actions, Action.permittedIn]

inductive HistoryEdit where
  | show
  | hide
  | toggle

def DetailView.editHistory (view : DetailView) : HistoryEdit → DetailView
  | .show => { view with historyOpen := true }
  | .hide => { view with historyOpen := false }
  | .toggle => { view with historyOpen := !view.historyOpen }

theorem historyEditPreservesActions (view : DetailView) (edit : HistoryEdit) :
    (view.editHistory edit).actions = view.actions := by
  cases edit <;> rfl

theorem historyTracePreservesActions (view : DetailView) (edits : List HistoryEdit) :
    (edits.foldl DetailView.editHistory view).actions = view.actions := by
  induction edits generalizing view with
  | nil => rfl
  | cons edit rest ih =>
    change (rest.foldl DetailView.editHistory (view.editHistory edit)).actions = view.actions
    exact (ih (view.editHistory edit)).trans (historyEditPreservesActions view edit)

private def Role.key : Role → String
  | .operator => "OPERATOR"
  | .viewer => "VIEWER"

private def Phase.key : Phase → String
  | .stopped => "STOPPED"
  | .running => "RUNNING"

private def Action.key : Action → String
  | .startNew => "start-new"
  | .copySettings => "copy-settings"
  | .stop => "stop"
  | .restart => "restart"

private def DetailView.toJson (view : DetailView) : Lean.Json :=
  Lean.Json.mkObj [
    ("role", .str view.role.key),
    ("phase", .str view.phase.key),
    ("historyOpen", .bool view.historyOpen),
    ("actions", .arr ((view.actions.map (fun action => .str action.key)).toArray))
  ]

def casesJson : Lean.Json :=
  let views := [Role.operator, .viewer].flatMap fun role =>
    [Phase.stopped, .running].flatMap fun phase =>
      [false, true].map fun historyOpen => DetailView.mk role phase historyOpen
  .arr ((views.map DetailView.toJson).toArray)

end BitOVP.LiveLayoutControls

def main : IO Unit :=
  IO.println BitOVP.LiveLayoutControls.casesJson.compress
