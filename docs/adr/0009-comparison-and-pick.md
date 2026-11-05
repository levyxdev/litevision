# A Comparison lets the User choose among Jobs, and the choice is a Pick, not a Rating

v1 left side-by-side comparison out because it multiplies the cost of every request. Several images from one Job only vary by chance; they cannot show which reading of an ambiguous request the User meant, or which Model does it better. A Comparison is therefore a set of Jobs started together for one request, differing in prompt, in Model, or both, sharing one Modality, at most four Jobs. Its cost is bounded by that cap and by the Agent starting one only when the User asks for it or agrees to it. The User's choice among its results is recorded as a Pick, a relative preference: the picked result may still be poor, and the others may be fine, so a Pick says nothing about Known-good Options (ADR 0006) and does not count as a Rating.

## Considered Options

- **Record the choice as a good Rating on the picked result**: rejected because winning against weaker results is not a verdict, and a false good would clear suspect options.
- **The Agent calls `generate_image` several times with a shared label**: rejected because the Agent would have to keep the group together itself and wait on each Job in turn; one tool starts the Jobs together and returns them as one Comparison.
