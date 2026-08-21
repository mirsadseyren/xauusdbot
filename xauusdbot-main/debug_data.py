import pandas as pd
import json

df = pd.read_parquet('data/xauusd_merged.parquet')
df_day = df.loc['2026-01-27']

out = {
    "count": len(df_day),
    "head": df_day.head().to_dict('records'),
    "tail": df_day.tail().to_dict('records')
}
with open('debug_data.json', 'w') as f:
    json.dump(out, f, indent=2)
