import type { KvStore } from "../storage/json-store.js";

/**
 * 用户偏好（音乐口味等）。偏好影响 Agent 的语义理解与建议，
 * 但不构成操作授权——执行仍走工具确认流程。
 */

export interface FavoriteSong {
  title: string;
  artist?: string;
}

export interface UserPreferences {
  favoriteSongs: FavoriteSong[];
  favoritePlaylists: string[];
  /** 其他长期偏好备注（自由文本）。 */
  notes: string;
  updatedAt: string;
}

const STORE_KEY = "preferences";

const EMPTY: Omit<UserPreferences, "updatedAt"> = {
  favoriteSongs: [],
  favoritePlaylists: [],
  notes: "",
};

export class PreferencesStore {
  constructor(private readonly store: KvStore, private readonly clock: () => Date = () => new Date()) {}

  load(): UserPreferences {
    const raw = this.store.read(STORE_KEY) as Partial<UserPreferences> | undefined;
    if (!raw) return { ...EMPTY, updatedAt: this.clock().toISOString() };
    return {
      favoriteSongs: Array.isArray(raw.favoriteSongs) ? raw.favoriteSongs : [],
      favoritePlaylists: Array.isArray(raw.favoritePlaylists) ? raw.favoritePlaylists : [],
      notes: typeof raw.notes === "string" ? raw.notes : "",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : this.clock().toISOString(),
    };
  }

  private save(prefs: UserPreferences): void {
    this.store.write(STORE_KEY, prefs);
  }

  addFavoriteSong(song: FavoriteSong): UserPreferences {
    const prefs = this.load();
    const key = (s: FavoriteSong) => `${s.title}::${s.artist ?? ""}`;
    if (!prefs.favoriteSongs.some((s) => key(s) === key(song))) {
      prefs.favoriteSongs.push(song);
    }
    prefs.updatedAt = this.clock().toISOString();
    this.save(prefs);
    return prefs;
  }

  removeFavoriteSong(title: string): UserPreferences {
    const prefs = this.load();
    prefs.favoriteSongs = prefs.favoriteSongs.filter((s) => s.title !== title);
    prefs.updatedAt = this.clock().toISOString();
    this.save(prefs);
    return prefs;
  }

  addFavoritePlaylist(playlist: string): UserPreferences {
    const prefs = this.load();
    if (!prefs.favoritePlaylists.includes(playlist)) prefs.favoritePlaylists.push(playlist);
    prefs.updatedAt = this.clock().toISOString();
    this.save(prefs);
    return prefs;
  }

  setNotes(notes: string): UserPreferences {
    const prefs = this.load();
    prefs.notes = notes;
    prefs.updatedAt = this.clock().toISOString();
    this.save(prefs);
    return prefs;
  }

  /** 生成注入 system prompt 的偏好摘要（控制长度，防上下文膨胀）。 */
  summary(): string {
    const p = this.load();
    const lines: string[] = [];
    if (p.favoriteSongs.length > 0) {
      lines.push(`喜欢的歌曲：${p.favoriteSongs.slice(0, 10).map((s) => (s.artist ? `${s.title}(${s.artist})` : s.title)).join("、")}`);
    }
    if (p.favoritePlaylists.length > 0) {
      lines.push(`喜欢的歌单：${p.favoritePlaylists.slice(0, 5).join("、")}`);
    }
    if (p.notes.trim() !== "") {
      lines.push(`备注：${p.notes.slice(0, 200)}`);
    }
    return lines.length === 0 ? "（暂无记录的音乐偏好）" : lines.join("\n");
  }
}
