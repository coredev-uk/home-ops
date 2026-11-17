using System.Collections.Frozen;
using System.Security.Cryptography;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>The stylesheets, scripts and font, read once from the assembly and fingerprinted.</summary>
public static class WebAssets
{
    /// <summary>Stylesheets in cascade order: the core theme first, modules after it.</summary>
    public static readonly string[] Stylesheets = ["hera-tv.css", "hera-home.css", "hera-discover.css"];

    /// <summary>Scripts in run order: modules register with the core, so it loads first.</summary>
    public static readonly string[] Scripts = ["hera-tv.js", "hera-home.js", "hera-discover.js"];

    private static readonly FrozenDictionary<string, Asset> Assets = Load();

    /// <summary>Gets the fingerprint of every asset together, used to bust caches.</summary>
    public static string Version { get; } = Convert.ToHexStringLower(
        SHA256.HashData(Assets.Values.SelectMany(a => a.Content).ToArray()))[..12];

    public static Asset? Get(string name) => Assets.GetValueOrDefault(name);

    private static FrozenDictionary<string, Asset> Load()
    {
        var assembly = typeof(WebAssets).Assembly;
        var types = Stylesheets.Select(name => (name, "text/css; charset=utf-8"))
            .Concat(Scripts.Select(name => (name, "text/javascript; charset=utf-8")))
            .Append(("InterVariable.woff2", "font/woff2"));

        return types.ToFrozenDictionary(
            t => t.Item1,
            t =>
            {
                using var stream = assembly.GetManifestResourceStream(t.Item1)
                    ?? throw new InvalidOperationException($"Embedded resource {t.Item1} is missing.");
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                return new Asset(memory.ToArray(), t.Item2);
            });
    }

    public sealed record Asset(byte[] Content, string ContentType);
}
