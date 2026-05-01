# syntax=docker/dockerfile:1.7
# =============================================================================
#  DotnetKonf 2026 — .NET 10 vs .NET 11 Async Demo
#
#  Multi-stage build:
#   1. build      — uses .NET 11 preview SDK to compile both AsyncBench TFMs
#                   (net10.0 + net11.0) and publish AsyncDemo for net10.0
#   2. runtime    — slim ASP.NET Core 10 image; AsyncBench is published as
#                   self-contained, so no .NET 11 runtime is required here.
# =============================================================================

# Pin to a specific .NET 11 preview SDK so the build is reproducible and
# does not race with NuGet.org availability of new preview runtime packages.
# (The rolling "11.0-preview" tag advances the SDK before its matching
# Microsoft.*Runtime packages are published to public feeds — that breaks
# `dotnet restore` until the packages catch up.)
ARG SDK_IMAGE=mcr.microsoft.com/dotnet/nightly/sdk:11.0.100-preview.3
ARG ASPNET_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0

# -----------------------------------------------------------------------------
#  Stage 1: build
# -----------------------------------------------------------------------------
FROM ${SDK_IMAGE} AS build
ARG TARGETARCH
WORKDIR /src

# Map docker arch to .NET RID
RUN case "${TARGETARCH:-amd64}" in \
        amd64) echo "linux-x64"  > /tmp/rid ;; \
        arm64) echo "linux-arm64" > /tmp/rid ;; \
        *) echo "Unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac

# Restore (cache-friendly: csproj layer first)
COPY DotnetKonf2026-Async.sln ./
COPY NuGet.config              ./
COPY src/AsyncBench/AsyncBench.csproj AsyncBench/
COPY src/AsyncDemo/AsyncDemo.csproj AsyncDemo/
RUN RID=$(cat /tmp/rid) && \
    dotnet restore AsyncBench/AsyncBench.csproj --runtime "$RID" && \
    dotnet restore AsyncDemo/AsyncDemo.csproj

# Copy the rest of the source
COPY src/AsyncBench/ AsyncBench/
COPY src/AsyncDemo/  AsyncDemo/

# Publish AsyncBench as SELF-CONTAINED for both target frameworks.
# This embeds the matching .NET runtime inside each apphost so that the
# final image does not need .NET 11 preview installed alongside .NET 10.
RUN RID=$(cat /tmp/rid) && \
    dotnet publish AsyncBench/AsyncBench.csproj \
        -c Release -f net10.0 -r "$RID" \
        --self-contained true \
        -p:PublishTrimmed=false \
        -p:DebugType=None -p:DebugSymbols=false \
        -o /out/bench/net10.0 && \
    dotnet publish AsyncBench/AsyncBench.csproj \
        -c Release -f net11.0 -r "$RID" \
        --self-contained true \
        -p:PublishTrimmed=false \
        -p:DebugType=None -p:DebugSymbols=false \
        -o /out/bench/net11.0

# Publish AsyncDemo (framework-dependent on ASP.NET Core 10)
RUN dotnet publish AsyncDemo/AsyncDemo.csproj \
        -c Release \
        --no-self-contained \
        -p:DebugType=None -p:DebugSymbols=false \
        -o /out/demo

# -----------------------------------------------------------------------------
#  Stage 2: runtime
# -----------------------------------------------------------------------------
FROM ${ASPNET_IMAGE} AS runtime

# wget is already present in aspnet image; if not, add it for the healthcheck.
WORKDIR /app

# Demo (ASP.NET 10 framework-dependent)
COPY --from=build /out/demo ./

# Self-contained AsyncBench binaries for both runtimes
COPY --from=build /out/bench ./AsyncBench/

# Make sure the apphosts are executable
RUN chmod +x AsyncBench/net10.0/AsyncBench AsyncBench/net11.0/AsyncBench

ENV ASPNETCORE_URLS=http://+:8080 \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_PRINT_TELEMETRY_MESSAGE=false \
    DOTNET_NOLOGO=1 \
    ASYNCBENCH_ROOT=/app/AsyncBench

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=12s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

ENTRYPOINT ["dotnet", "AsyncDemo.dll"]
