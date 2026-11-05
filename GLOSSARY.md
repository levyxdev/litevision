# litevision

litevision lets an AI agent generate images and videos through models the user already pays for, configured once with the user's own API keys.

## Roles

**User**:
The human who owns the API keys and configures litevision.
_Avoid_: Customer, account

**Agent**:
The AI assistant (Claude Code, Codex, …) that calls litevision to generate media on the User's behalf.
_Avoid_: Client, bot

## Configuration

**Provider**:
One place the User has an account with: a base URL plus a Credential. A User might have `openai`, `gemini`, `venice` and `apimart`.
_Avoid_: Endpoint, vendor, relay (a relay is just a Provider)

**Credential**:
The secret a Provider needs, usually an API key. The User enters it; the Agent never sees it.
_Avoid_: Token, secret

**Protocol**:
The wire format litevision speaks to call a Model, independent of who hosts it. Two Models on the same Provider may use different Protocols.
_Avoid_: API format, adapter (the adapter is the code that implements a Protocol)

**Model**:
One generation model reachable through one Provider, using one Protocol. The same upstream model offered by two Providers is two Models.
_Avoid_: Engine

**Modality**:
The kind of media a Model generates: image or video. Every Model has exactly one.
_Avoid_: Type, category, kind, media type

**Alias**:
The short, User-chosen name the Agent uses to pick a Model, e.g. `gpt-image-cheap`.
_Avoid_: Nickname, model id (the model id is the Provider's own name for it)

## Generation

**Job**:
One generation request sent to one Model, from submission until its results are saved locally. Every generation is a Job, even when the Provider answers immediately.
_Avoid_: Task (APIMart's word for its own server-side job), request, run

**Comparison**:
A set of Jobs started together for one request so the User can pick among their results. Its Jobs may differ in prompt, in Model, or both, but all share one Modality. Started only when the User asks for it or agrees to it.
_Avoid_: Batch, group, candidate set

**Rating**:
The User's explicit verdict on one Job, or on one result of it: good or bad, plus a one-line reason. Recorded only when the User actually states it.
_Avoid_: Feedback, review, score

**Pick**:
The result the User chose within a Comparison. A relative preference, not a Rating: the picked result is not thereby good, nor the others bad. Recorded only when the User actually chooses.
_Avoid_: Choice, winner, vote

**Known-good Options**:
The `provider_options` a Model is known to honour: sent by a completed Job whose result matched what was asked, as far as litevision can check (an image's aspect ratio, a video's duration), and that the User has not rated bad. Options last sent by a Job the User rated bad are _suspect_ instead, shown with the Rating's reason, until a Job rated good sends them again. So are options last sent by a Job whose result did not match, until a matching Job sends them again.
_Avoid_: Working options, defaults, presets

**Model Notes**:
A short note about a Model that helps the Agent choose it, e.g. "photoreal, cheap, bad at Chinese text". The User and the Agent may both change it, but only to text the User has agreed to.
_Avoid_: Description, reviews
