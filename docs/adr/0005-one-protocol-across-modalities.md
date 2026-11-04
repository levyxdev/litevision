# One Protocol covers every Modality of a Provider's API

When a Provider's API generates both images and videos, litevision speaks it through one Protocol, and the Model's Modality picks which part of that API a Job calls. Together AI's images are synchronous at `/v1/images/generations` while its videos are asynchronous jobs at `/v2/videos`, yet both are the `together` Protocol. Gemini (Veo), Venice and APIMart also offer video beside images, so the same rule will hold for them; a Protocol's adapter grows a video half rather than a sibling Protocol appearing. This refines ADR 0002: a Protocol is still defined by how the Provider behaves, but it is the whole of one Provider's API family, not one endpoint.

## Considered Options

- **One Protocol per Modality** (`together-images`, `together-videos`): rejected because the User would pick a different Protocol for each Model of the same account, and every Provider with video would double its Protocols while sharing their base URL, Credential checks, model list and error mapping.
