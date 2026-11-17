using System.Collections.Concurrent;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>Finds a user's films and shows by TMDB id, honouring that user's library access.</summary>
public sealed class LibraryLookup(ILibraryManager libraryManager)
{
    private readonly ConcurrentDictionary<Guid, (DateTime Expires, Dictionary<string, BaseItem> Items)> _byUser = new();

    /// <summary>Gets the user's item for a TMDB id and kind ("movie" or "tv"), or null.</summary>
    public BaseItem? Find(User user, string mediaType, string? tmdbId)
    {
        if (string.IsNullOrEmpty(tmdbId))
        {
            return null;
        }

        return Index(user).GetValueOrDefault(Key(mediaType, tmdbId));
    }

    private static string Key(string mediaType, string tmdbId) => $"{(mediaType == "tv" ? "tv" : "movie")}:{tmdbId}";

    // The household library is small: one pass over every film and show, kept for a minute,
    // answers every lookup a page makes.
    private Dictionary<string, BaseItem> Index(User user)
    {
        var now = DateTime.UtcNow;
        if (_byUser.TryGetValue(user.Id, out var hit) && hit.Expires > now)
        {
            return hit.Items;
        }

        var items = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
            Recursive = true,
            IsVirtualItem = false,
        });

        var index = new Dictionary<string, BaseItem>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            if (item.TryGetProviderId(MetadataProvider.Tmdb, out var tmdb) && !string.IsNullOrEmpty(tmdb))
            {
                index.TryAdd(Key(item is MediaBrowser.Controller.Entities.TV.Series ? "tv" : "movie", tmdb), item);
            }
        }

        _byUser[user.Id] = (now + TimeSpan.FromMinutes(1), index);
        return index;
    }
}
