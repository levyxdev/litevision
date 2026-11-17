# Option Status evidence lives apart from the Job history, so a Job can be deleted

The User can delete Jobs from the Job history, for good: the Job's records, its Ratings, any Pick of it, and its Results. Option Statuses were derived from the Job history on every read (ADR 0011), so deleting a Job would also have erased what litevision learnt from it, and an Agent would walk into the same rejected size again. The Job history is the User's record, theirs to delete; what litevision learns about a Model's options is litevision's knowledge, kept for as long as the Model is used. Storing the two in one place made deleting one damage the other.

litevision therefore keeps the evidence apart, in `~/.litevision/evidence.jsonl`: append-only, one line per Job when it ends, holding only the facts an Option Status reads: the Model (Provider, Protocol, model id, Modality), the `provider_options` sent, what the request asked for, what each Result turned out to be, what the Provider's error said, the date and the Job's id. It holds no prompt, no Result or Reference path, no Rating and no Pick. Option Statuses are derived from it on every read, as before from the Job history, so a better result check or Parameter Guide still re-judges old evidence. Deleting a Job touches only the Job history and its Results; evidence from a deleted Job is shown with its date and without a link. Each read first writes the evidence of any ended Job the Job history has and the evidence lacks: every Job on the first run after upgrading, and otherwise a Job whose evidence failed to be written when it ended, which never fails the Job itself. Evidence counts in the order the Jobs ended, which each line records, so a line written late takes its proper place.

A `provider_options` value stays in the evidence after its Job is deleted, free text such as a `negative_prompt` included, since saying which value a Provider rejected needs the value.

This replaces ADR 0011 where it derives Option Statuses from the Job history; everything else in ADR 0011 stands.

## Considered Options

- **Keep only the derived Option Statuses**, updated as each Job ends: rejected because old evidence would stay judged by the rules of the release that recorded it, and several litevision processes would rewrite one file at once.
- **On deletion, reduce a Job that is currently evidence to its facts, inside the Job history**: rejected because the Job history would hold two kinds of Job record, and what counts as current evidence moves with every later Job.
- **Refuse to delete a Job that is currently evidence**: rejected because which Jobs are protected changes over time, and deleting everything would always leave some prompts and Results on disk.
- **Let the evidence go with the Job**: rejected because the Agent would lose what litevision had learnt about rejected and ignored options.
