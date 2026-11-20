---
name: litevision
description: Writing prompts for litevision's generate_image, generate_video and generate_comparison, checking each result, when to propose a Comparison or new Model Notes, and setting up a local Model on the User's machine.
---

# litevision

Drawn from the Model makers' own prompting guides (Sources, below).

## Write the prompt

- **English**, whatever language the User writes in: every Model handles it, and some handle only a few other languages well [Google]. Text that must appear in the result stays in its own language and script, exactly as it must read, in double quotes, with where it goes and how it looks: `A red banner across the top reads "新年快乐" in bold brush calligraphy.` Ask for that text and no other; spell unusual words letter by letter [OpenAI, Google, FLUX].
- **Describe the scene in sentences**, most important first: the subject, the setting, the composition (framing, camera angle), the lighting, the style or medium. Sentences carry relationships a keyword list loses: who holds what, what stands behind what, where the light comes from [Google, FLUX, Seedream, OpenAI].
- **Exact counts and positions**: "three lemons in a row on the left half, a knife lying diagonally at the bottom right", rather than "some lemons".
- **Say what should be there**: "an empty, deserted street" rather than "no cars". FLUX has no negative prompt at all [Google, FLUX].
- **With reference images**, name each by position ("image 1", "image 2") and say what it is for: litevision sends `references` in the order given and has no field for an image's role, so the prompt carries it. "Image 1 is the person; image 2 is only a layout guide, take nothing else from it." Say what changes, then list what must stay unchanged (identity, pose, layout, lighting, text): "Change only the jacket to red leather; keep the face, pose, background and lighting of image 1 exactly as they are" [OpenAI, Google, FLUX].

## Set the Model's own parameters

litevision translates nothing. The size, resolution, quality and length go in `provider_options`, under the Model's own field names from its Parameter Guide (`list_models` with `model`): `{ "size": "2048x1152" }` for GPT Image, `{ "response_format": { "aspect_ratio": "16:9", "image_size": "2K" } }` for Gemini, `{ "resolution": "1080P", "ratio": "9:16", "seconds": "10" }` for Wan 2.7. Leave them out and the Provider's defaults apply. Weigh the guide's prices: on some Models a larger size costs no more. The Model's Standing Options are already sent; set a key to `null` to drop one for a Job. When the User wants a value on every Job of a Model, show them the old and new Standing Options and, once they agree, call `update_standing_options`.

`list_models` gives each value sent before an Option Status, with the Job and date of the latest evidence. Reuse Honoured values. Accepted only means the Provider did not reject it; its effect is unknown. Never resend a Rejected or Ignored value unchanged: fix it from the Provider's message or the mismatch, and the Parameter Guide.

## Ask for one image

Leave `n` at 1 unless the User wants several to choose from. Images from one Job differ only by chance; to explore different readings of a request, propose a Comparison instead.

## Start several Jobs at once

Tool calls often run one after another, even when sent together, so each waited-for `generate_image` or `generate_video` Job waits for the one before. When the User wants several separate results, such as different prompts, Models or options, start each Job with `wait: false`: it returns the `job_id` at once and the Job runs in the background. Then call `get_job` for each one; together they take about as long as the slowest. When the User no longer wants a running Job, call `cancel_job`.

## Name the files

Pass `name` when the request says what a result is for or who it shows, in the User's own words and language: `name: "张三"` for Zhang San's ID photo saves `张三.png`. litevision adds `-1`, `-2` for several results and the next free number when the name is taken. Without it, files are named after the time the Job started. In a Comparison, give each variant its own `name` when the variants are for different things.

## Check every result

Before reporting a result, open each file and check it against the request: subject, counts, positions, each quoted text letter by letter, what had to stay unchanged. Tell the User plainly what is wrong, then let them decide what comes next: generate again when they ask, and leave the verdict to them.

## Propose a Comparison

Propose one when the request is ambiguous (two readings that would look clearly different: "a logo for Sol", sun or Spanish?) or when no Model clearly fits it, judging by the Parameter Guides, Model Notes and Ratings `list_models` shows. Say what each variant tries.

Write the variants so the User's Pick says something:

- For an ambiguous request: one variant per reading, on the same Model, each prompt a full description of that reading.
- To compare Models: the same prompt on each Model, and in each variant's own `provider_options` the same shape in that Model's own fields.
- Between variants, change only that one thing.

## Set up a local Model

When the User wants images made on their own machine, with no Provider, install a local Model. Do everything yourself except what only the User can do; leave every command that needs `sudo` to them.

1. **Check the machine.** `local install` says whether litevision runs local Models here and which quantisation fits its memory. On Windows, first run `nvidia-smi`: it must answer, and its header must show `CUDA Version` 12 or later. If it does not, hand the User installing or updating the NVIDIA driver, then check again.
2. **Choose the Model.** `flux-3-klein` generates and edits, and is the one to start with. `z-image-turbo` only generates, in fewer steps. `qwen-image-2.1` and `qwen-image-2.1-turbo` are larger and for non-commercial use only. Smaller images are much faster: start at 512 to 768 pixels on a 16 GB machine.
3. **See what it needs.** Run `npx -y litevision local install <model>` without `--yes`. It downloads nothing and prints the licence, the speed, the quantisation it chose for this machine's memory, and every file with its size. Check the free disk space (`df -h ~`; on Windows, `Get-PSDrive`) against the total.
4. **Ask the User once.** Say which Model, its licence, and how many GB it will download, and pass on any warning that it will likely not fit, with the alternative the command suggests. Only after they agree, run the command with `--yes`, adding `--force` only if they insist on a Model that will likely not fit.
5. **Generate** with the Alias the install printed.

What to hand the User:

- **A download refused with HTTP 401 or 403.** Every file litevision installs is public, so this means the file has been gated since this release. Tell the User which file it was, and stop.
- **On a Mac, more GPU memory (optional).** If a Job fails for memory or swaps heavily, the User may run `sudo sysctl iogpu.wired_limit_mb=<MB>` themselves. Tell them the risk: leaving macOS too little memory can freeze the machine until it restarts. The setting resets at restart.
- **An `sd-server` the User runs themselves.** litevision starts and shares its own instead. Suggest the User keep only litevision's, and leave stopping or removing theirs to them.

## Propose new Model Notes

Propose new Model Notes when a Rating or Pick shows something the Model's Notes do not say ("misspells Chinese text", "picked over the others for photoreal scenes", "quality=low looks blurry"), or when the User asks. A Rating never changes an Option Status, so the Model Notes are where the effect of an option no check can measure gets written down. At most once per Model per conversation. Write only what is particular to that Model, including where it departs from this Skill ("follows Chinese prompts better than English"); leave out what holds for every Model: this Skill covers it.

## Sources

- [OpenAI] Image prompting: https://developers.openai.com/api/docs/guides/image-prompting
- [Google] Nano Banana image generation, "Prompting guide and strategies": https://ai.google.dev/gemini-api/docs/image-generation
- [FLUX] Black Forest Labs, Prompting Basics and Technical Parameters: https://docs.bfl.ai/guides/prompting_unified_basics, https://docs.bfl.ai/guides/prompting_unified_technical; Together AI, FLUX quickstart, "Prompting best practices": https://docs.together.ai/docs/quickstart-flux
- [Seedream] ByteDance, Seedream 4.0-4.5 prompt guide: https://docs.byteplus.com/en/docs/modelark/seedream-4-0-5-0-prompt-guide

Other makers' Models follow the same advice; their Model Notes record where one departs from it.
