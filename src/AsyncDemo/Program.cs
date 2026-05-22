using System.Diagnostics;
using System.Text.Json;
using AsyncDemo;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<BenchmarkRunner>();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/source", () => Results.Text(BenchmarkRunner.SourceCode, "text/plain; charset=utf-8"));

app.MapPost("/api/run", async (BenchmarkRunner runner, int? outer, int? chain, int? iterations, CancellationToken ct) =>
{
    var result = await runner.RunAsync(outer ?? 1_000, chain ?? 10_000, iterations ?? 5, ct);
    return Results.Json(result);
});

app.Run();

namespace AsyncDemo
{
    public sealed class BenchmarkRunner
    {
        public const string SourceCode = """
            // Her outer görev içinde 10.000 ardışık await — sonuçlar lokal,
            // .NET 10: her await için heap'te async state machine box'lanır
            // .NET 11: <Features>runtime-async=on</Features> ile state machine stack'te kalır

            static async Task<long> RunWorkloadAsync(int outerTasks, int chainDepth)
            {
                var tasks = new Task<long>[outerTasks];
                for (int i = 0; i < outerTasks; i++)
                    tasks[i] = OuterAsync(i, chainDepth);
                var results = await Task.WhenAll(tasks);
                long total = 0;
                for (int i = 0; i < results.Length; i++) total += results[i];
                return total;
            }

            static async Task<long> OuterAsync(int seed, int chainDepth)
            {
                long acc = seed;
                for (int i = 0; i < chainDepth; i++)
                    acc = await StepAsync(acc) ^ (long)i;   // sonuç escape etmez
                return acc;
            }

            [MethodImpl(MethodImplOptions.NoInlining)]
            static async Task<long> StepAsync(long x)
            {
                await Task.CompletedTask;
                return (x * 1103515245L + 12345L) & 0x7fffffffL;
            }
            """;

        private static readonly string BenchFileName =
            OperatingSystem.IsWindows() ? "AsyncBench.exe" : "AsyncBench";

        private static readonly string Net10Exe = ResolveExe("net10.0");
        private static readonly string Net11Exe = ResolveExe("net11.0");

        // (outer, chain, iterations) → result. Cache TTL'i 3 gün — sunum boyunca
        // ısınmış kalır, instance restart olmadıkça aynı preset'e tekrar tekrar
        // tıklanınca payload anında üretilir. Cache hit dışa belli edilmez:
        // her yanıt minimum MinTotalMs sürer ve istemciye CacheHit gönderilmez.
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, CachedRun> _cache = new();
        private static readonly TimeSpan CacheTtl = TimeSpan.FromDays(3);
        private static readonly bool CacheEnabled =
            !string.Equals(Environment.GetEnvironmentVariable("BENCH_NO_CACHE"), "1", StringComparison.Ordinal);
        private const int MinTotalMs = 5000;

        public async Task<RunPayload> RunAsync(int outerTasks, int chainDepth, int iterations, CancellationToken ct)
        {
            var key = $"{outerTasks}-{chainDepth}-{iterations}";
            var sw = Stopwatch.StartNew();

            RunPayload payload;
            if (CacheEnabled
                && _cache.TryGetValue(key, out var cached)
                && cached.ExpiresAt > DateTime.UtcNow)
            {
                payload = cached.Payload;
            }
            else
            {
                // İki runtime'ı paralel başlat — vCPU contention iki tarafta eşit
                // olduğundan göreceli speedup/allocation farkı korunur.
                var task10 = ExecuteAsync(Net10Exe, outerTasks, chainDepth, iterations, ct);
                var task11 = ExecuteAsync(Net11Exe, outerTasks, chainDepth, iterations, ct);
                await Task.WhenAll(task10, task11);
                var net10 = await task10;
                var net11 = await task11;

                var speedup = net10.MinElapsedMs / net11.MinElapsedMs;
                var allocSavings = net10.MinAllocatedBytes == 0
                    ? 0
                    : 1.0 - ((double)net11.MinAllocatedBytes / net10.MinAllocatedBytes);
                var allocRatio = net11.MinAllocatedBytes == 0
                    ? double.PositiveInfinity
                    : (double)net10.MinAllocatedBytes / net11.MinAllocatedBytes;

                payload = new RunPayload(
                    OuterTasks: outerTasks,
                    ChainDepth: chainDepth,
                    TotalAwaits: (long)outerTasks * chainDepth,
                    Iterations: iterations,
                    Net10: net10,
                    Net11: net11,
                    Speedup: speedup,
                    AllocationSavings: allocSavings,
                    AllocationRatio: allocRatio
                );

                if (CacheEnabled)
                {
                    _cache[key] = new CachedRun(payload, DateTime.UtcNow.Add(CacheTtl));
                }
            }

            // Her yanıt için minimum süre — kullanıcı her tıklamada gerçekten bench
            // çalışıyormuş hissi yaşasın, cache hit ile sıfır arası ayırt edilemesin.
            var remaining = MinTotalMs - (int)sw.ElapsedMilliseconds;
            if (remaining > 0) await Task.Delay(remaining, ct);

            return payload;
        }

        private record CachedRun(RunPayload Payload, DateTime ExpiresAt);

        private static async Task<BenchmarkResult> ExecuteAsync(string exePath, int outer, int chain, int iterations, CancellationToken ct)
        {
            var psi = new ProcessStartInfo(exePath)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("--outer");
            psi.ArgumentList.Add(outer.ToString());
            psi.ArgumentList.Add("--chain");
            psi.ArgumentList.Add(chain.ToString());
            psi.ArgumentList.Add("--iterations");
            psi.ArgumentList.Add(iterations.ToString());
            // Self-contained benches in Docker pin an exact runtime; local framework-dependent
            // builds may only have a newer patch (e.g. 10.0.4) on the machine.
            if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ASYNCBENCH_ROOT")))
                psi.Environment["DOTNET_ROLL_FORWARD"] = "Disable";
            psi.Environment["DOTNET_TieredPGO"] = "1";

            using var proc = Process.Start(psi) ?? throw new InvalidOperationException($"Failed to start {exePath}");

            var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
            var stderrTask = proc.StandardError.ReadToEndAsync(ct);
            await proc.WaitForExitAsync(ct);

            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            if (proc.ExitCode != 0)
            {
                throw new InvalidOperationException($"Bench failed (exit {proc.ExitCode}). stderr={stderr}");
            }

            string? json = null;
            foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (line.StartsWith('{') && line.EndsWith('}')) json = line;
            }
            if (json is null)
                throw new InvalidOperationException("No JSON line in bench output: " + stdout);

            var result = JsonSerializer.Deserialize<BenchmarkResult>(json, JsonOpts)
                         ?? throw new InvalidOperationException("Failed to parse bench output: " + stdout);
            return result;
        }

        private static string ResolveExe(string tfm)
        {
            var here = AppContext.BaseDirectory;
            var envRoot = Environment.GetEnvironmentVariable("ASYNCBENCH_ROOT");

            var candidates = new List<string>();
            if (!string.IsNullOrWhiteSpace(envRoot))
            {
                candidates.Add(Path.GetFullPath(Path.Combine(envRoot, tfm, BenchFileName)));
            }
            candidates.AddRange(new[]
            {
                // Production / container layout: bench published next to the demo app.
                Path.GetFullPath(Path.Combine(here, "AsyncBench", tfm, BenchFileName)),
                // Local dev layout: solution folder one level up, bench builds in its own bin.
                Path.GetFullPath(Path.Combine(here, "..", "..", "..", "..", "AsyncBench", "bin", "Release", tfm, BenchFileName)),
                Path.GetFullPath(Path.Combine(here, "..", "..", "..", "..", "AsyncBench", "bin", "Debug", tfm, BenchFileName)),
            });

            foreach (var c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            throw new FileNotFoundException(
                $"AsyncBench apphost not found for {tfm}. Tried:\n  {string.Join("\n  ", candidates)}\nBuild AsyncBench in Release first.");
        }

        private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);
    }

    public record IterationSample(
        double ElapsedMs,
        long AllocatedBytes,
        int Gen0,
        int Gen1,
        int Gen2,
        long Checksum);

    public record BenchmarkResult(
        string Runtime,
        string FrameworkDescription,
        int OuterTasks,
        int ChainDepth,
        long TotalAwaits,
        int Iterations,
        double MinElapsedMs,
        double MedianElapsedMs,
        double AvgElapsedMs,
        long MinAllocatedBytes,
        long MedianAllocatedBytes,
        long AvgAllocatedBytes,
        double BytesPerAwait,
        int TotalGen0,
        int TotalGen1,
        int TotalGen2,
        IterationSample[] Samples);

    public record RunPayload(
        int OuterTasks,
        int ChainDepth,
        long TotalAwaits,
        int Iterations,
        BenchmarkResult Net10,
        BenchmarkResult Net11,
        double Speedup,
        double AllocationSavings,
        double AllocationRatio);
}
