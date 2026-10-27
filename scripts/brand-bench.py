import sys, colorsys
from collections import Counter
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
W, H = im.size
px = im.load()
def bgish(c):
    r, g, b = c
    h, s, v = colorsys.rgb_to_hsv(r/255, g/255, b/255)
    return v > 0.80 and s < 0.12
a = Image.new('L', (W, H), 255); ap = a.load()
for y in range(H):
    for x in range(W):
        if bgish(px[x, y]): ap[x, y] = 0
rgba = im.convert('RGBA'); rgba.putalpha(a)
bbox = a.point(lambda v: 255 if v else 0).getbbox()
rgba = rgba.crop(bbox)
w, h = rgba.size; side = max(w, h)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0)); sq.paste(rgba, ((side-w)//2, (side-h)//2))
N = 160; cell = side / N; sp = sq.load()
small = Image.new('RGBA', (N, N), (0, 0, 0, 0)); smp = small.load()
for j in range(N):
    for i in range(N):
        x0, x1 = int(i*cell), max(int((i+1)*cell), int(i*cell)+1)
        y0, y1 = int(j*cell), max(int((j+1)*cell), int(j*cell)+1)
        cols = [sp[x, y] for y in range(y0, y1) for x in range(x0, x1)]
        op = [c[:3] for c in cols if c[3]]
        if len(op) * 2 > len(cols):
            # quantize lightly then take the most common colour in the cell
            q = Counter((r//8*8, g//8*8, b//8*8) for r, g, b in op).most_common(1)[0][0]
            smp[i, j] = q + (255,)
# palette: 18 colours over opaque pixels
rgb = Image.new('RGB', (N, N)); rgb.paste(small.convert('RGB'))
pal = rgb.quantize(colors=28, method=Image.Quantize.MAXCOVERAGE).convert('RGB')
pp = pal.load()
for j in range(N):
    for i in range(N):
        if smp[i, j][3]: smp[i, j] = pp[i, j] + (255,)
# blend any remaining pale, unsaturated pixel into its neighbours
for _ in range(2):
    fix = []
    for j in range(N):
        for i in range(N):
            c = smp[i, j]
            if not c[3]: continue
            h_, s_, v_ = colorsys.rgb_to_hsv(*(k/255 for k in c[:3]))
            if v_ > 0.78 and s_ < 0.30:
                nb = [smp[x, y] for x, y in ((i-1,j),(i+1,j),(i,j-1),(i,j+1)) if 0<=x<N and 0<=y<N and smp[x, y][3]]
                nb = [n for n in nb if not (colorsys.rgb_to_hsv(*(k/255 for k in n[:3]))[2] > 0.78 and colorsys.rgb_to_hsv(*(k/255 for k in n[:3]))[1] < 0.30)]
                fix.append((i, j, Counter(nb).most_common(1)[0][0] if nb else (0, 0, 0, 0)))
    for i, j, c in fix: smp[i, j] = c
# drop lone opaque pixels
for j in range(N):
    for i in range(N):
        if smp[i, j][3] and sum(1 for x, y in ((i-1,j),(i+1,j),(i,j-1),(i,j+1)) if 0<=x<N and 0<=y<N and smp[x, y][3]) <= 1:
            smp[i, j] = (0, 0, 0, 0)
small.save(out)
