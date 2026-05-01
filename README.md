# .NET 10 vs .NET 11 — Async Performance Demo

A live, side-by-side benchmark for **DotnetKonf 2026**. Built to demonstrate
the impact of **Runtime Async** — the new feature in .NET 11 that lets the
runtime keep async state machines on the **stack** instead of boxing them on
the **heap** like every prior version.

The demo is a single web page. Audience members scan a QR code, tap **Start
Test**, and watch two identical pieces of code run on two different runtimes —
and see the heap-allocation gap rendered as a **virtual DIMM RAM stick** that
fills up chip by chip in real time.

---

## TL;DR

| | .NET 10 | .NET 11 (`runtime-async=on`) | Delta |
| --- | ---: | ---: | --- |
| Time (10M awaits) | ~80 ms | ~37 ms | **2.0× faster** |
| Heap allocated | ~687 MB | ~94 KB | **~7,400× less** |
| GC collections | 25× Gen0 | 0 | none |

Same source file, two different IL outputs (controlled by a single MSBuild
flag), measured by spawning two independent self-contained executables — no
emulation, no estimation.

---

## The async story

Since C# 5, every `async` method has been compiled into a state machine
struct. As soon as a method actually awaits something incomplete, the compiler
**boxes** that struct onto the heap so the continuation can resume on a
different stack later. With deeply nested or chained awaits, this means a
fresh heap allocation per await, per call.

.NET 11 introduces **Runtime Async**, where the runtime — not the compiler —
manages suspension and resumption. When the JIT can prove a state machine
doesn't escape (i.e. the awaited result is consumed locally), it keeps the
state machine on the stack. Result: **near-zero heap allocation** for await
chains that previously dominated GC pressure.

Enable it per project:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0'">
  <Features>runtime-async=on</Features>
</PropertyGroup>
```

> Same C# source. The flag only changes the IL the compiler emits for
> `net11.0`, so the `net10.0` build measures the classic state machine and the
> `net11.0` build measures Runtime Async — apples to apples.

---

## The benchmark

The demo measures **escape-free await chains** because that is exactly the
shape Runtime Async optimises:

```csharp
// 1,000 outer tasks × 10,000 sequential awaits = 10,000,000 awaits
static async Task<long> OuterAsync(int seed, int chainDepth)
{
    long acc = seed;
    for (int i = 0; i < chainDepth; i++)
        acc = await StepAsync(acc) ^ (long)i;   // result stays local
    return acc;
}

[MethodImpl(MethodImplOptions.NoInlining)]
static async Task<long> StepAsync(long x)
{
    await Task.CompletedTask;
    return (x * 1103515245L + 12345L) & 0x7fffffffL;
}
```

For each iteration the bench reports min/median/avg time, total bytes
allocated, GC counts per generation, and the allocation rate per await.

---

## What's in the box

```
DotnetKonf2026-Dotnet11-Async-Test/
├── DotnetKonf2026-Async.sln     # solution at the repo root
├── Dockerfile                   # multi-stage build → ASP.NET 10 runtime
├── .dockerignore
├── README.md
└── src/
    ├── AsyncBench/              # Multi-target console (net10.0;net11.0)
    │   ├── AsyncBench.csproj    # runtime-async=on for net11.0
    │   └── Program.cs           # workload + JSON output to stdout
    │
    └── AsyncDemo/               # ASP.NET Core 10 web orchestrator
        ├── AsyncDemo.csproj
        ├── Program.cs           # /api/run spawns both AsyncBench binaries
        └── wwwroot/
            ├── index.html       # hero, arena, modal-hosted source code
            ├── style.css        # mobile-first dark theme + DIMM visuals
            └── app.js           # state machine, RAM-chip animation
```

The solution also contains a **Solution Items** folder that surfaces the
`Dockerfile`, `.dockerignore`, and this `README.md` directly inside Visual
Studio / JetBrains Rider so they are easy to edit alongside the code.

The web app is a thin orchestrator: when you POST to `/api/run` it spawns the
**.NET 10** apphost, captures its JSON, then spawns the **.NET 11** apphost
and captures its JSON, and returns a combined payload for the frontend to
animate.

---

## Quick start (local development)

**Prereqs**

- macOS / Linux / Windows
- .NET SDK **10.0** (stable)
- .NET SDK **11.0 preview 3 or newer** (for the `net11.0` target)
- Both runtimes installed side by side

```bash
# from the repo root
dotnet build DotnetKonf2026-Async.sln -c Release

# run the demo
cd src/AsyncDemo
ASPNETCORE_URLS="http://localhost:5146" dotnet run -c Release
```

Open <http://localhost:5146> and click **Start Test**.

To expose it on your local network (e.g. for a QR code from the slide deck):

```bash
ASPNETCORE_URLS="http://0.0.0.0:5146" dotnet run -c Release --no-launch-profile
```

The QR code should point at `http://<your-lan-ip>:5146`.

---

## Docker

The Dockerfile uses a two-stage build:

1. **Stage 1 — build**: pulls the .NET 11 preview SDK, restores both
   projects, then publishes AsyncBench **self-contained** for both
   `net10.0` and `net11.0`. Self-contained means each apphost ships with
   its own runtime, so we don't need to mix two minor versions of .NET
   in the runtime image.
2. **Stage 2 — runtime**: copies everything onto a slim
   `mcr.microsoft.com/dotnet/aspnet:10.0` image. `AsyncDemo` is
   framework-dependent (it runs on the ASP.NET 10 runtime already in the
   base image); `AsyncBench` runs from `/app/AsyncBench/<tfm>/AsyncBench`.

### Build and run

```bash
docker build -t async-demo .
docker run --rm -p 8080:8080 async-demo
```

Then open <http://localhost:8080>.

### Multi-arch

The Dockerfile honours `TARGETARCH`. `docker buildx` will produce
`linux/amd64` or `linux/arm64` images automatically:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t myreg/async-demo:latest --push .
```

### Behind a reverse proxy / custom domain

The container listens on port `8080`. Point your reverse proxy (Caddy,
Traefik, nginx, Cloud Run, App Service, Fly.io, etc.) at it. There are no
sticky sessions, no auth, no database — the entire app is two stateless HTTP
endpoints plus three static files.

Example `docker-compose.yml`:

```yaml
services:
  demo:
    build: .
    image: async-demo
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      ASPNETCORE_URLS: "http://+:8080"
```

Example `Caddyfile`:

```caddy
async.example.com {
    reverse_proxy demo:8080
}
```

---

## Configuration

### HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| `GET`  | `/`              | Static index page |
| `GET`  | `/api/source`    | Plain-text C# source rendered in the modal |
| `POST` | `/api/run`       | Runs both bench processes and returns JSON |

`POST /api/run` accepts three optional query-string parameters:

| Param | Default | Description |
| --- | ---: | --- |
| `outer`      | `1000`   | Concurrent outer tasks (`Task.WhenAll` width) |
| `chain`      | `10000`  | Sequential awaits inside each outer task |
| `iterations` | `5`     | Repeated samples; min/median/avg are reported |

Total await calls = `outer × chain × iterations`. Defaults give 50M awaits
across the whole run; one bench iteration is ~80 ms on .NET 10.

### Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `ASPNETCORE_URLS` | `http://+:8080` (in Docker) | Listen address |
| `ASYNCBENCH_ROOT` | unset (uses layout next to the demo) | Override directory containing `<tfm>/AsyncBench` apphosts |

`ASYNCBENCH_ROOT` is the only knob you need if you ever publish the bench to
a different location than `/app/AsyncBench` inside the image.

---

## Notes & caveats

- **Preview runtime.** This demo targets .NET 11 *preview*. Numbers will
  shift between previews and RTM. The build pins to whatever preview SDK
  the Dockerfile pulls, so a rebuild is enough to follow new previews.
- **Self-contained bench.** The Docker image embeds the .NET 11 preview
  runtime inside the AsyncBench `net11.0` apphost. The runtime image
  itself is just ASP.NET 10. This means a fresh `docker build` is needed
  to upgrade either runtime.
- **No client-side simulation.** The frontend animation is purely cosmetic
  pacing — every number rendered (time, allocations, GC counts) comes
  straight from the bench process for that runtime. The "race" duration is
  scaled so the slower lane finishes its grid in ~3.5 s of wall-clock time.
- **Mobile first.** The page targets phones (the QR-code use case): high
  contrast text, touch-sized buttons, full-screen modal, reduced motion
  support, safe-area insets for the iOS notch.

---

## Credits

Built for **DotnetKonf 2026** by Murat Dinç.

The Runtime Async story behind this benchmark is the work of the .NET
runtime team — see Microsoft's
[What's new in .NET 11 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime)
docs and the .NET 11 preview release notes.
