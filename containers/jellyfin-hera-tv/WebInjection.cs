using System.Text;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<IStartupFilter, WebInjection>();
        serviceCollection.AddSingleton<Integrations.UpstreamClient>();
        serviceCollection.AddSingleton<Integrations.LibraryLookup>();
    }
}

/// <summary>
/// Adds the Hera TV stylesheet, font preload and script to the web client's index.html as it is
/// served. Nothing on disk changes, so the image's read-only web folder is fine, and turning the
/// plugin off (or removing it) restores the stock page on the next load.
/// </summary>
public sealed class WebInjection(ILogger<WebInjection> logger) : IStartupFilter
{
    private const string Marker = "data-hera-tv";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(InvokeAsync);
        next(app);
    };

    private static bool IsIndex(PathString path)
    {
        var value = path.Value;
        return value is not null
            && (value.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
                || value.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
                || value.EndsWith("/web", StringComparison.OrdinalIgnoreCase));
    }

    private async Task InvokeAsync(HttpContext context, Func<Task> next)
    {
        if (!HttpMethods.IsGet(context.Request.Method)
            || !IsIndex(context.Request.Path)
            || Plugin.Instance?.Configuration.Enabled != true)
        {
            await next().ConfigureAwait(false);
            return;
        }

        // A plain, whole 200 is the only body worth rewriting.
        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("Range");
        context.Request.Headers.Remove("If-Range");
        context.Request.Headers.Remove("If-None-Match");
        context.Request.Headers.Remove("If-Modified-Since");

        var original = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await next().ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = original;
        }

        buffer.Position = 0;
        var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
            && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);
        if (!isHtml)
        {
            await buffer.CopyToAsync(original).ConfigureAwait(false);
            return;
        }

        var html = Encoding.UTF8.GetString(buffer.ToArray());
        var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        var bodyEnd = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (headEnd < 0 || bodyEnd < 0 || html.Contains(Marker, StringComparison.Ordinal))
        {
            await original.WriteAsync(buffer.ToArray()).ConfigureAwait(false);
            return;
        }

        var v = WebAssets.Version;
        // The stylesheet asks for the font by a bare relative URL, so the preload must match it.
        var head =
            $"<link {Marker} rel=\"preload\" as=\"font\" type=\"font/woff2\" crossorigin href=\"../HeraTV/InterVariable.woff2\">" +
            string.Concat(WebAssets.Stylesheets.Select(name => $"<link {Marker} rel=\"stylesheet\" href=\"../HeraTV/{name}?v={v}\">"));
        var body = string.Concat(WebAssets.Scripts.Select(name => $"<script {Marker} src=\"../HeraTV/{name}?v={v}\" defer></script>"));

        html = new StringBuilder(html.Length + head.Length + body.Length)
            .Append(html, 0, headEnd).Append(head)
            .Append(html, headEnd, bodyEnd - headEnd).Append(body)
            .Append(html, bodyEnd, html.Length - bodyEnd)
            .ToString();

        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentLength = bytes.Length;
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.Remove("Last-Modified");
        context.Response.Headers.CacheControl = "no-cache";
        await original.WriteAsync(bytes).ConfigureAwait(false);
        logger.LogDebug("Injected Hera TV {Version} into {Path}", v, context.Request.Path);
    }
}
