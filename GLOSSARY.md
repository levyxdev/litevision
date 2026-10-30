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

**Alias**:
The short, User-chosen name the Agent uses to pick a Model, e.g. `gpt-image-cheap`.
_Avoid_: Nickname, model id (the model id is the Provider's own name for it)

## Generation

**Job**:
One generation request sent to one Model, from submission until its results are saved locally. Every generation is a Job, even when the Provider answers immediately.
_Avoid_: Task (APIMart's word for its own server-side job), request, run

**Rating**:
The User's explicit verdict on one Job: good or bad, plus a one-line reason. Recorded only when the User actually states it.
_Avoid_: Feedback, review, score

**Model Notes**:
A short note about a Model that helps the Agent choose it, e.g. "photoreal, cheap, bad at Chinese text". The User and the Agent may both change it, but only to text the User has agreed to.
_Avoid_: Description, reviews
