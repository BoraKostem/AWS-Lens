# Session Hub Usage

## What Session Hub Does

Session Hub is the app's cross-account assume-role workspace. It lets you:

- save reusable assume-role targets
- assume a role immediately from a form or from a saved target
- keep temporary STS credentials in memory only
- activate an assumed session as the current app context
- open the embedded terminal in the active base-profile or assumed-role context
- launch Compare Workspace with either base profiles or active assumed sessions

Session Hub is available from the left navigation as `Session Hub`.

## How To Use It

### 1. Select a Base Profile First

Before using Session Hub, select a base AWS profile from the profile catalog. The selected profile becomes the source profile used to:

- discover IAM roles for suggestions in the `Role ARN` field
- scope the visible saved targets list
- perform the actual STS `AssumeRole` call

If you activate an assumed session later, the app switches its working connection from the base profile to the assumed-role session.

### 2. Create a Saved Assume-Role Target

In `Saved Targets`, fill in:

- `Label`: friendly name shown in the UI
- `Role ARN`: target role to assume
- `Default Session Name`: default STS session name
- `External ID`: optional
- `Source Profile`: local AWS profile that will call STS
- `Default Region`: region used when the role is assumed

Click `Save Target`.

Saved targets are persisted locally and survive app restarts. The app stores them in Electron `userData` as `session-hub.json`.

Important behavior:

- saved targets are sorted by label
- the UI only shows targets for the currently selected base profile
- editing a target updates its `updatedAt` timestamp but keeps its original `createdAt`

### 3. Assume a Role Immediately

There are two ways to assume a role:

- click `Assume Now` from the form
- click `Assume` on a saved target card

When the assume call succeeds, the app:

- calls STS `AssumeRole`
- validates that a full temporary credential set was returned
- calls `GetCallerIdentity` with the temporary credentials
- stores the session in memory
- refreshes Session Hub state
- activates the new session as the app's current connection

The session list then shows:

- status: `active` or `expired`
- expiry hint: `expiring soon` when less than 15 minutes remain
- account ID
- access key ID
- expiration timestamp
- countdown until expiration

### 4. Activate or Revert Context

In `Assumed Sessions`:

- `Activate` makes that session the active app connection
- `Terminal` opens the embedded terminal with that session's AWS environment
- `Re-Assume` requests a fresh STS session using the same role details and original STS session name
- `Forget` removes the stored in-memory session

When a session is close to expiring, Session Hub also surfaces:

- an `expiring soon` status chip in the session table
- a top-level refresh recommendation banner
- `Refresh Expiring` and `Refresh Active Context` shortcuts for one-click renewal

At the top of the page:

- `Revert To Base Profile` clears the active assumed session
- `Refresh` reloads profiles, regions, saved targets, and current sessions

When a session is active, the rest of the AWS workspaces use that assumed-role connection until you revert to the base profile or activate a different session.

## Compare Workspace Flow

The `Account Comparison` section can launch Compare Workspace from:

- a base profile
- an active assumed session

Both left and right sides use the region currently selected in the app when you open compare mode.

This is the intended workflow for side-by-side account inspection without rewriting local AWS config files.

## Embedded Terminal Behavior

The embedded terminal shares the same AWS context model as the GUI.

For a base profile, the terminal environment is set with:

- `AWS_PROFILE`
- `AWS_REGION`
- `AWS_DEFAULT_REGION`

For an assumed session, the terminal environment is set with:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`
- `AWS_REGION`
- `AWS_DEFAULT_REGION`

The terminal context updates when you switch between base profiles and assumed sessions.

## Persistence And Security Model

Session Hub intentionally separates persisted target metadata from temporary credentials.

Persisted locally:

- saved assume-role targets

Stored in memory only:

- assumed-role credentials
- active assumed sessions

Not written to AWS shared config files:

- temporary access key ID
- temporary secret access key
- session token

In practice this means:

- saved targets remain after restart
- assumed sessions do not survive restart
- expired sessions stay visible until refreshed or forgotten, but cannot be used successfully

## Operational Notes

- `Label`, `Role ARN`, and `Default Session Name` are required to save a target.
- `Role ARN`, `Session Name`, and `Source Profile` are required to assume a role.
- If a session expires, actions that require credentials will fail until you `Re-Assume`.
- If a saved target is deleted, existing in-memory sessions created from it remain until they expire or are forgotten.
- Activating a session also aligns the app region to that session's region.

## Typical Workflow

1. Select a local AWS base profile.
2. Open `Session Hub`.
3. Save one or more assume-role targets for that profile.
4. Click `Assume` on the target you want.
5. Use `Activate` if you want to switch back to another active session later.
6. Open service consoles or the terminal in the assumed-role context.
7. Use `Revert To Base Profile` when you want to return to the original local profile context.
