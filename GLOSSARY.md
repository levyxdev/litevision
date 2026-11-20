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
One place litevision sends Jobs to: a base URL, plus a Credential where the Provider is an account. A User might have `openai`, `gemini`, `venice`, `apimart`, and `local` for a Runtime on their own machine, which needs no Credential.
_Avoid_: Endpoint, vendor, relay (a relay is just a Provider)

**Credential**:
The secret a Provider needs, usually an API key. The User enters it; the Agent never sees it.
_Avoid_: Token, secret

**Runtime**:
The inference server that runs Models on the User's own machine: stable-diffusion.cpp's `sd-server`. It loads one Model at a time, from a recipe whose id is the Model's model id. One per machine, shared by every litevision process.
_Avoid_: Backend, engine, local server

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

**Parameter Guide**:
What litevision knows in advance about the request parameters of a Model's family, gathered from the Provider's docs: each parameter's allowed values, its default, how it changes the price, where it is documented and when that was last checked. It informs the Agent; litevision never refuses a request because of it. Where the Provider describes its Models itself, the Provider's answer wins.
_Avoid_: Capabilities (they suggest limits litevision enforces), parameter schema (the Provider's own description of its parameters)

## Generation

**Job**:
One generation request sent to one Model, from submission until its results are saved locally. Every generation is a Job, even when the Provider answers immediately. A Job still running when the litevision session running it ended is _interrupted_: `get_job` picks it up again where the Provider allows, and it can be deleted.
_Avoid_: Task (APIMart's word for its own server-side job), request, run

**Result**:
One image or video file a Job saved. A Job may have several, numbered from 1.
_Avoid_: Output, generated file

**Reference**:
An image given to a Job to generate from: a reference image, or a video's first or last frame. It belongs to whoever supplied it, never to the Job.
_Avoid_: Input, input image

**Job history**:
litevision's record of the User's Jobs, with their Ratings and Picks. Deleting a Job removes it from the Job history for good.
_Avoid_: History, log, records

**Comparison**:
A set of Jobs started together for one request so the User can pick among their results. Its Jobs may differ in prompt, in Model, or both, but all share one Modality. Started only when the User asks for it or agrees to it.
_Avoid_: Batch, group, candidate set

**Rating**:
The User's explicit verdict on one Job, or on one result of it: good or bad, plus a one-line reason. Recorded only when the User actually states it. It judges the result, never the options that produced it.
_Avoid_: Feedback, review, score

**Pick**:
The result the User chose within a Comparison. A relative preference, not a Rating: the picked result is not thereby good, nor the others bad. Recorded only when the User actually chooses.
_Avoid_: Choice, winner, vote

**Source Job**:
An earlier Job whose result is one of a Job's reference images, a video's first or last frame included. litevision finds it by the content of the image, so a copy found anywhere counts. A Job may have several Source Jobs, or none.
_Avoid_: Parent, base, derived-from

**Option Status**:
What the latest evidence says about one `provider_options` value on one Model, from facts alone, never from a Rating: _Honoured_ (the result was checked and matched), _Ignored_ (the result was checked and did not match), _Rejected_ (the Provider's error named it), or _Accepted_ (not rejected, but its effect cannot be checked). Fields checked together, such as a width and a height, share one Option Status.
_Avoid_: Known-good options, suspect options, working options

**Evidence**:
What one ended Job showed about its Model's `provider_options`: the values sent, what each Result turned out to be, and what the Provider's error said. Option Statuses are derived from it. litevision keeps it when the Job is deleted, without the prompt or any path.
_Avoid_: Facts, log, history

**Standing Options**:
The `provider_options` the User has set for a Model, sent with every Job of that Model. Whatever the Agent passes for a Job overrides them. The User sets them, or the Agent with the User's agreement, unlike an Option Status, which litevision learns from past Jobs.
_Avoid_: Default options, presets

**Model Notes**:
A short note about a Model that helps the Agent choose it, e.g. "photoreal, cheap, bad at Chinese text" or "quality=low looks blurry". Where the effect of an option that no check can measure gets written down. The User and the Agent may both change it, but only to text the User has agreed to.
_Avoid_: Description, reviews
