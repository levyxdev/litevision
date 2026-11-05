# litevision informs the Agent about parameters and never restricts them

litevision used to sit between the Agent and the Provider as a gatekeeper. Each Model had a table of capabilities holding one size per aspect ratio, nearly always about a megapixel. The adapter reserved the size fields, so `provider_options` could not change them. Requests were checked against the table before anything was sent, and an unsupported aspect ratio was quietly swapped for the closest one. That table was the only thing standing between the Agent and the Model's real range, and it was wrong in both directions. `gpt-image-2.5` could not be asked for 2K or 4K at all. A Together model litevision did not recognise was capped at 1024 a side and refused reference images. The tables also went stale within weeks, as Providers retired models and added parameters.

litevision therefore no longer restricts what the Agent asks for. Its job is to know each Model's parameters in advance, in a Parameter Guide gathered from the Provider's docs: allowed values, defaults, how a value changes the price, the source, and the date it was checked. It hands that knowledge to the Agent through `list_models`, and again when the Provider rejects an option. The Agent writes the Provider's own fields in `provider_options`. The Provider decides what is valid, and its error tells the Agent what to fix.

- Only fields whose value is fixed by how litevision works stay reserved: the Model's id, the fields that carry the prompt and the reference images litevision reads from disk, and the response format litevision parses. Everything else passes through, `size` and `n` included.
- Nothing is refused before the request, and nothing is adjusted. No checks on image counts, reference counts or aspect ratios, and no swapping in the closest ratio.
- No parameter is translated across Models. `aspect_ratio`, `resolution` and `duration` are no longer top-level parameters of `generate_image`, `generate_video` or `generate_comparison`. An Agent that wants the same shape from two Models writes each Model's own field, in separate calls or in separate Comparison variants. The Agent is the caller, and making several calls costs it nothing.
- `n` stays, because it shapes the Job rather than the image: it is how many results the Job brings back, which Ratings and Picks refer to. It goes into the Provider's count field where there is one. Where there is none, as with Gemini, litevision splits the Job into several requests.
- When the Agent sends no size, litevision sends none, and the Provider's own default applies. litevision never picks a default on the User's behalf. A User who always wants 2K from a Model sets it as that Model's Standing Options. The Agent's options override them: objects merge key by key, other values replace, and `null` removes a key for that Job.
- Where the Provider describes its Models itself (Venice, APIMart), that answer still wins over the built-in Parameter Guide, as in ADR 0004.
- Checking results against the request (ADR 0006) stays. What is checked against changes: no longer the size litevision chose, but what the final request actually asked for, which litevision reads from the fields named in the Parameter Guide. A request whose size or duration it cannot read is not checked.
- A Provider that accepts reference images only as public links gets them through its own upload endpoint, when it has one (APIMart's `/v1/uploads/images`). The User's images then reach only a Provider they already use. litevision never uploads them to a third-party host.

This applies to video as well as images. It replaces ADR 0004 where that ADR treats capabilities as limits a request is checked against, and ADR 0006 where it checks results against the size litevision chose.

## Considered Options

- **Resolution tiers for images, like video's**: one size per aspect ratio per tier, chosen through a new `resolution` parameter. Rejected because it keeps litevision deciding which sizes exist. Every arbitrary-size model, every new ratio and every new tier would wait on a release, and the tables would still go stale.
- **Keep `aspect_ratio` as a translated convenience**, so one Comparison request fits every Model: rejected because the translation hides each Model's real parameters behind litevision's guess at them. The Agent can just as easily write each Model's own fields.
- **Default to the cheapest tier**: rejected because several Models charge the same for 2K as for 1K. Whether a larger size is worth it is for the Agent to judge from the Parameter Guide's prices, or for the User to fix in Standing Options.
- **Upload reference images to a free public host** such as catbox: rejected because it sends the User's images to a service they never chose, and the Provider's own upload endpoint does the job.

## Consequences

More requests reach the Provider and fail there, rather than failing early in litevision. Each such failure costs one round trip, and the Agent retries a rejected option at most twice. The Parameter Guide is the part of litevision that ages. It ships with each release, and every entry carries the date it was checked, so an Agent looking at an old entry knows to read the docs link first.
