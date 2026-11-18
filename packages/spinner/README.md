# @nicknisi/pi-spinner (retired)

The random working verbs and the shimmer now live in [`@nicknisi/pi-composer`](../composer#readme) 1.0, under `working` in `composer.json`:

| spinner.json        | composer.json                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shimmer`           | `working.shimmer`                                                                                                                                                           |
| `shimmerPeriodMs`   | `working.shimmerPeriodMs`                                                                                                                                                   |
| `baseColor`         | `working.baseColor`                                                                                                                                                         |
| `highlightColor`    | `working.highlightColor`                                                                                                                                                    |
| `bandWidth`         | `working.bandWidth`                                                                                                                                                         |
| `hideSpinner: true` | `spinner.frames: []` (no spinner anywhere). Or leave it: with the default `prompt.whenBusy: "spinner"` the spinner moves into the prompt symbol instead of the working row. |
| `shimmerIntervalMs` | fixed at 80ms                                                                                                                                                               |

This last release is a stub that warns once per session and does nothing else. Remove it from your pi packages:

```sh
pi remove npm:@nicknisi/pi-spinner      # installed from npm
pi list                                  # installed from a local path: find it here,
pi remove /path/to/packages/spinner        # then remove that path
```
