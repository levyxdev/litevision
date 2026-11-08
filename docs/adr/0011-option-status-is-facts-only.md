# An Option Status comes from facts alone, and a Rating never changes it

ADR 0006 let a bad Rating make a Job's options suspect, because a Rating was the only signal for options litevision cannot check. In use this mixed two questions: whether a Model honours a value, and whether the User liked the result. One User rated an ID photo bad because "the hair looks unnatural", and the only width and height Together accepts for 3:4 on that Model became suspect, steering the next Agent towards sizes the Provider rejects. A Rating also cannot be undone by later unrated Jobs, and Users rarely say "good".

litevision therefore keeps an Option Status per value per Model from facts alone:

- **Honoured** or **Ignored**: the result was checked against what the request asked for and matched, or did not. The check covers aspect ratio and video duration as before (ADR 0006, ADR 0010), and now also pixel size where the request names exact dimensions or a tier the Parameter Guide sizes, and the file format where the request names one.
- **Rejected**: the Provider's error named the option. The Provider's message is kept with it. An error that names no option records nothing.
- **Accepted**: sent and not rejected, but nothing can check its effect (`quality`, `seed`, `style`, `negative_prompt`, …).

A mismatch or a rejection affects only the fields that were checked or named, not every option the Job sent. Fields a check reads together, such as `width` and `height`, share one Option Status, because a Provider may accept each value only in certain pairs. The latest evidence wins, and it is shown with its date and Job, so an Agent looking at old evidence knows to read the docs first. The User sees Option Statuses read-only in the settings page: they are facts, and a value the User always wants belongs in Standing Options.

Ratings and Picks judge results only. When the User's verdict says something about an option no check can measure ("quality=low looks blurry"), the Agent proposes it for the Model Notes, with the User's agreement (ADR 0008).

This replaces ADR 0006 where a bad Rating makes options suspect, and where a mismatch makes all of a Job's options suspect. Known-good and suspect options are retired in favour of the Option Status.

## Considered Options

- **Let a bad Rating taint only options no check covers**: rejected because it still turns a verdict on the result into a claim about parameters, and nothing ever clears it.
- **Have the Agent mark whether a Rating is about content or options**: rejected because it asks the Agent to guess what the User meant, and most verdicts are about the picture.
- **Count successes against failures**: rejected because a Provider that changes its rules makes old successes misleading; the latest evidence, dated, says more.
