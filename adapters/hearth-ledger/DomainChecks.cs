using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HearthDb.Enums;

namespace HearthLedger
{
    internal static class DomainChecks
    {
        private static int _passed;
        private static int _failed;
        private static string _output;

        private static void Check(string id, Action scenario)
        {
            try { scenario(); _passed++; Console.WriteLine("PASS " + id); }
            catch (Exception error) { _failed++; Console.WriteLine("FAIL " + id + " | " + error.Message); }
        }

        private static void Expect(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }

        private static Match Game(int place, bool duos)
        {
            return new Match { Id = Guid.NewGuid(), HeroId = "demo-hero", HeroName = "Demo",
                Ended = new DateTime(2026, 11, 21, 0, 0, 0, DateTimeKind.Utc), Place = place, Duos = duos };
        }

        private static string Archive()
        {
            return Path.Combine(_output, "history-" + Guid.NewGuid().ToString("N") + ".xml");
        }

        private static Guide Guide(string name, int[] core, int[] enablers, int[] addons)
        {
            return new Guide { Name = name, CoreCards = core, Enablers = enablers, Addons = addons };
        }

        private static Recommendation[] Rank(Guide[] guides, BoardPiece[] board, int[] shop)
        {
            return Recommendations.Rank(guides, board, shop, null);
        }

        private static int Main(string[] args)
        {
            _output = args[0];
            Check("solo-summary", () => {
                var summary = new Summary(new[] { Game(1, false), Game(7, false), Game(2, true) }, false);
                Expect(summary.Games == 2 && summary.Average == 4 && summary.Wins == 50 && summary.Top == 50,
                    "Solo summary must exclude Duos and use top-4.");
            });
            Check("duos-summary", () => {
                var summary = new Summary(new[] { Game(1, true), Game(2, true), Game(4, true), Game(8, false) }, true);
                Expect(summary.Games == 3 && summary.Top > 66 && summary.Top < 67 && summary.Places.Length == 4,
                    "Duos summary must use four placements and top-2.");
            });
            Check("empty-summary", () => {
                var summary = new Summary(new Match[0], false);
                Expect(summary.Games == 0 && summary.Average == null && summary.Wins == null, "Empty history must have unknown rates.");
            });
            Check("invalid-placements", () => {
                Expect(!Game(0, false).IsValid && !Game(9, false).IsValid && !Game(5, true).IsValid, "Invalid placement accepted.");
                Expect(Game(8, false).IsValid && Game(4, true).IsValid, "Valid boundary rejected.");
            });
            Check("history-retry-and-late-mmr", () => {
                var path = Archive();
                var history = new History(path);
                var game = Game(1, false);
                Expect(history.Record(game), "Initial record failed.");
                Expect(!history.Record(game), "Retry must be idempotent.");
                var update = Game(1, false);
                update.Id = game.Id;
                update.RatingBefore = 6000;
                update.RatingAfter = 6095;
                update.Ended = game.Ended.AddDays(1);
                Expect(history.Record(update), "Late rating update ignored.");
                var restored = new History(path);
                Expect(restored.Matches.Count == 1 && restored.Matches[0].RatingDelta == 95
                    && restored.Matches[0].Ended == game.Ended, "Roundtrip must preserve original time and updated rating.");
            });
            Check("history-mode-correction", () => {
                var path = Archive();
                var history = new History(path);
                var game = Game(2, false);
                history.Record(game);
                var corrected = Game(2, true);
                corrected.Id = game.Id;
                Expect(history.Record(corrected), "Same-ID change from Solo to Duos was ignored.");
                Expect(new History(path).Matches[0].Duos, "Corrected mode did not survive reload.");
            });
            Check("unknown-rating", () => {
                var game = Game(1, false);
                game.RatingAfter = 6000;
                Expect(game.RatingDelta == null, "Missing previous rating must not imply a 6000-point gain.");
            });
            Check("support-alone-does-not-pivot", () => {
                var guide = Guide("Support", new[] { 1 }, new int[0], new[] { 2 });
                Expect(Rank(new[] { guide }, new[] { new BoardPiece { Id = 2 } }, new int[0]).Length == 0,
                    "An addon alone should not recommend an archetype.");
            });
            Check("shop-enabler-and-offer-dedup", () => {
                var guides = new[] { Guide("A", new[] { 1 }, new[] { 3 }, new int[0]),
                    Guide("B", new[] { 2 }, new[] { 3 }, new int[0]) };
                var ranked = Rank(guides, new BoardPiece[0], new[] { 3 });
                var offers = Recommendations.Offers(ranked);
                Expect(ranked.Length == 2 && offers.Length == 1 && offers[0].Id == 3,
                    "Shop enabler should be discoverable once across multiple guides.");
            });
            Check("lobby-tribe-filter", () => {
                var guide = Guide("Excluded tribe", new[] { 1 }, new int[0], new int[0]);
                guide.PrimaryTribe = 999;
                var ranked = Recommendations.Rank(new[] { guide }, new[] { new BoardPiece { Id = 1 } },
                    new int[0], new HashSet<Race> { (Race)20 });
                Expect(ranked.Length == 0, "Guide for absent tribe should be filtered.");
            });
            Check("golden-strength-and-board-dedup", () => {
                var a = Guide("A", new[] { 1 }, new int[0], new int[0]);
                var b = Guide("B", new[] { 2 }, new int[0], new int[0]);
                var normal = new BoardPiece { Id = 2, Tier = 3, Stats = 10 };
                var golden = new BoardPiece { Id = 1, Tier = 3, Stats = 10, Golden = true };
                var ranked = Rank(new[] { b, a }, new[] { normal, golden }, new int[0]);
                Expect(ranked[0].Guide.Name == "A", "Golden board piece should influence ranking.");
                var duplicate = Rank(new[] { a }, new[] { golden, golden }, new int[0]);
                Expect(duplicate[0].Core == 1 && duplicate[0].Score == ranked[0].Score, "Repeated card ID must not multiply core score.");
            });
            Check("rank-label-boundaries", () => {
                var guide = new Guide { Rank = 1 };
                Expect(guide.RankLetter == "S", "Rank 1 must map to S.");
                guide.Rank = 5;
                Expect(guide.RankLetter == "D", "Rank 5 must map to D.");
                guide.Rank = 0;
                Expect(guide.RankLetter == "", "Unknown rank must stay unknown.");
            });
            Console.WriteLine("RESULT passed=" + _passed + " failed=" + _failed);
            return _failed == 0 ? 0 : 1;
        }
    }
}
