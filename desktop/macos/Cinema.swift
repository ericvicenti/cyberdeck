import SwiftUI

// A page owns its scroll hierarchy. Reusing index IDs across different pages can leave
// LazyVGrid/ScrollViewReader rendering a previous page even though the model moved on.
struct CinemaView: View {
    @ObservedObject var model: Workspace
    let page: Page
    private let accent = Color(red: 0.98, green: 0.33, blue: 0.25)
    private var featured: Tile? {
        if let feature = page.feature { return feature }
        if page.tiles.indices.contains(model.selection), page.tiles[model.selection].image != nil { return page.tiles[model.selection] }
        return page.tiles.first(where: { $0.image != nil })
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 24) {
                Text("AFTERGLOW").font(.system(size: 24, weight: .black, design: .rounded)).tracking(4).foregroundStyle(accent)
                Spacer()
                if let navigation = page.shelves.first {
                    ForEach(navigation.start..<(navigation.start + navigation.count), id: \.self) { index in
                        Button { guard model.page.id == page.id else { return }; model.selection = index; model.input("select") } label: {
                            Text(page.tiles[index].title).font(.system(size: 16, weight: .semibold))
                                .padding(.horizontal, 13).padding(.vertical, 11)
                                .background(model.selection == index && model.inputMode != .pointer ? accent : .clear)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain)
                    }
                }
            }.padding(.horizontal, 48).padding(.vertical, 22).background(Color.black.opacity(0.6))
            ScrollViewReader { vertical in
                ScrollView {
                    VStack(alignment: .leading, spacing: 32) {
                        hero
                        ForEach(Array(page.shelves.dropFirst().enumerated()), id: \.offset) { _, row in
                            VStack(alignment: .leading, spacing: 15) {
                                Text(row.title).font(.system(size: 25, weight: .bold)).padding(.horizontal, 48)
                                ScrollViewReader { horizontal in
                                    ScrollView(.horizontal) {
                                        HStack(alignment: .top, spacing: 22) {
                                            ForEach(row.start..<(row.start + row.count), id: \.self) { index in
                                                CinemaPoster(tile: page.tiles[index], selected: model.selection == index && model.inputMode != .pointer, accent: accent) {
                                                    guard model.page.id == page.id else { return }; model.selection = index; model.input("select")
                                                }.id(index)
                                            }
                                        }.padding(.horizontal, 48).padding(.vertical, 10)
                                    }.scrollIndicators(.hidden)
                                    .onChange(of: model.selection) { _, value in
                                        if value >= row.start && value < row.start + row.count {
                                            withAnimation(.easeOut(duration: 0.15)) { horizontal.scrollTo(value, anchor: .center) }
                                        }
                                    }
                                }
                            }.id(row.start)
                        }
                        if page.shelves.count < 2 && !model.busy {
                            Text("Nothing here yet. Browse Films or Series to find something to watch.").foregroundStyle(.secondary).padding(48)
                        }
                    }.padding(.bottom, 30)
                }.scrollIndicators(.hidden)
                .onChange(of: model.selection) { _, value in
                    guard let row = page.shelves.first(where: { value >= $0.start && value < $0.start + $0.count }) else { return }
                    withAnimation(.easeOut(duration: 0.18)) { vertical.scrollTo(row.start, anchor: row.start == 0 ? .top : .center) }
                }
            }
            HStack {
                if model.inputMode == .controller { Text("✚ Browse     A Play / select     B Back     X Search     Y Home") }
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Text(model.message.isEmpty ? (model.busy ? "Loading…" : "") : model.message).lineLimit(2).foregroundStyle(.white)
            }.font(.system(size: 14, weight: .medium)).foregroundStyle(.white.opacity(0.6))
                .padding(.horizontal, 48).padding(.vertical, 18).background(Color.black.opacity(0.6))
        }.background(Color(red: 0.035, green: 0.035, blue: 0.045)).foregroundStyle(.white)
    }
    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            if let url = featured?.backdrop ?? featured?.image {
                GeometryReader { geometry in
                    AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Color.white.opacity(0.03) }
                        .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                }
            }
            LinearGradient(colors: [.black.opacity(0.05), .black.opacity(0.9)], startPoint: .top, endPoint: .bottom)
            LinearGradient(colors: [.black.opacity(0.7), .clear], startPoint: .leading, endPoint: .trailing)
            VStack(alignment: .leading, spacing: 16) {
                Text(page.title == "Afterglow" ? "YOUR OWN LITTLE CINEMA" : page.title.uppercased()).font(.system(size: 13, weight: .bold)).tracking(3).foregroundStyle(accent)
                Text(featured?.title ?? "Something good is waiting.").font(.system(size: 46, weight: .bold, design: .rounded)).lineLimit(2)
                Text(featured?.subtitle ?? "Films, series and your library.").font(.system(size: 18)).foregroundStyle(.white.opacity(0.8)).lineLimit(3).frame(maxWidth: 750, alignment: .leading)
            }.padding(.horizontal, 48).padding(.bottom, 32)
        }.frame(height: 310).clipped().id(0)
    }
}

private struct CinemaPoster: View {
    let tile: Tile
    let selected: Bool
    let accent: Color
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.07))
                    if let url = tile.image {
                        AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: {
                            Image(systemName: tile.symbol).font(.system(size: 40)).foregroundStyle(.white.opacity(0.4))
                        }
                    } else { Image(systemName: tile.symbol).font(.system(size: 45)).foregroundStyle(selected ? accent : .white) }
                }.frame(width: 186, height: 265).clipped().clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? accent : .clear, lineWidth: 4))
                    .scaleEffect(selected ? 1.035 : 1)
                Text(tile.title).font(.system(size: 17, weight: .semibold)).lineLimit(2).frame(width: 186, height: 43, alignment: .topLeading)
            }.foregroundStyle(selected ? .white : .white.opacity(0.7))
        }.buttonStyle(.plain).accessibilityLabel(tile.title)
    }
}
