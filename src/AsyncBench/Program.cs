using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;

const int DefaultOuter = 1_000;       // paralel WhenAll görev sayısı
const int DefaultChain = 10_000;      // her görevin ardışık await derinliği
const int DefaultWarmupOuter = 200;
const int DefaultWarmupChain = 500;
const int DefaultIterations = 5;

var outer = DefaultOuter;
var chain = DefaultChain;
var iterations = DefaultIterations;

for (int i = 0; i < args.Length - 1; i++)
{
    if (args[i] == "--outer" && int.TryParse(args[i + 1], out var o)) outer = o;
    if (args[i] == "--chain" && int.TryParse(args[i + 1], out var c)) chain = c;
    if (args[i] == "--iterations" && int.TryParse(args[i + 1], out var it)) iterations = Math.Max(1, it);
}

await RunWorkloadAsync(DefaultWarmupOuter, DefaultWarmupChain);

var samples = new IterationSample[iterations];

for (int it = 0; it < iterations; it++)
{
    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();

    var allocBefore = GC.GetTotalAllocatedBytes(precise: true);
    var gen0Before = GC.CollectionCount(0);
    var gen1Before = GC.CollectionCount(1);
    var gen2Before = GC.CollectionCount(2);

    var sw = Stopwatch.StartNew();
    var sum = await RunWorkloadAsync(outer, chain);
    sw.Stop();

    var allocAfter = GC.GetTotalAllocatedBytes(precise: true);

    samples[it] = new IterationSample(
        ElapsedMs: sw.Elapsed.TotalMilliseconds,
        AllocatedBytes: allocAfter - allocBefore,
        Gen0: GC.CollectionCount(0) - gen0Before,
        Gen1: GC.CollectionCount(1) - gen1Before,
        Gen2: GC.CollectionCount(2) - gen2Before,
        Checksum: sum
    );
}

var elapsedSorted = samples.Select(s => s.ElapsedMs).OrderBy(x => x).ToArray();
var allocSorted = samples.Select(s => s.AllocatedBytes).OrderBy(x => x).ToArray();
var totalAwaits = (long)outer * chain;

var result = new BenchmarkResult(
    Runtime: DetectRuntimeKey(),
    FrameworkDescription: RuntimeInformation.FrameworkDescription,
    OuterTasks: outer,
    ChainDepth: chain,
    TotalAwaits: totalAwaits,
    Iterations: iterations,
    MinElapsedMs: elapsedSorted[0],
    MedianElapsedMs: elapsedSorted[elapsedSorted.Length / 2],
    AvgElapsedMs: samples.Average(s => s.ElapsedMs),
    MinAllocatedBytes: allocSorted[0],
    MedianAllocatedBytes: allocSorted[allocSorted.Length / 2],
    AvgAllocatedBytes: (long)samples.Average(s => (double)s.AllocatedBytes),
    BytesPerAwait: (double)allocSorted[0] / Math.Max(1, totalAwaits),
    TotalGen0: samples.Sum(s => s.Gen0),
    TotalGen1: samples.Sum(s => s.Gen1),
    TotalGen2: samples.Sum(s => s.Gen2),
    Samples: samples
);

Console.WriteLine(JsonSerializer.Serialize(result, BenchmarkResultContext.Default.BenchmarkResult));
return 0;

static async Task<long> RunWorkloadAsync(int outerTasks, int chainDepth)
{
    var tasks = new Task<long>[outerTasks];
    for (int i = 0; i < outerTasks; i++)
    {
        tasks[i] = OuterAsync(i, chainDepth);
    }
    var results = await Task.WhenAll(tasks);
    long total = 0;
    for (int i = 0; i < results.Length; i++) total += results[i];
    return total;
}

// "Outer" görev yalnızca tek bir Task<long>'a iliştirilir.
// İçindeki ardışık awaitlerin sonuçları lokal değişkene yazılır → escape etmezler.
// .NET 11 runtime async iyileştirmesi bu state machine'leri stack'te tutabilir;
// .NET 10 her await için heap'te builder + state machine box'lar.
static async Task<long> OuterAsync(int seed, int chainDepth)
{
    long acc = seed;
    for (int i = 0; i < chainDepth; i++)
    {
        acc = await StepAsync(acc) ^ (long)i;
    }
    return acc;
}

[MethodImpl(MethodImplOptions.NoInlining)]
static async Task<long> StepAsync(long x)
{
    // Tek bir senkron tamamlanmış await — JIT'in boxing'i tamamen elimine etmesi için.
    await Task.CompletedTask;
    return (x * 1103515245L + 12345L) & 0x7fffffffL;
}

static string DetectRuntimeKey()
{
#if NET11_0_OR_GREATER
    return "net11";
#elif NET10_0_OR_GREATER
    return "net10";
#else
    return "unknown";
#endif
}

public record IterationSample(
    double ElapsedMs,
    long AllocatedBytes,
    int Gen0,
    int Gen1,
    int Gen2,
    long Checksum
);

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
    IterationSample[] Samples
);

[System.Text.Json.Serialization.JsonSerializable(typeof(BenchmarkResult))]
internal partial class BenchmarkResultContext : System.Text.Json.Serialization.JsonSerializerContext { }
