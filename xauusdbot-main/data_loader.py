import pandas as pd
import os

class DataLoader:
    def __init__(self, filepath: str):
        self.filepath = filepath
        self.df_1m = None
        self.df_3m = None
        self.df_4h = None

    def load_and_prepare(self):
        print(f"Loading data from {self.filepath}...")
        self.df_1m = pd.read_parquet(self.filepath)
        
        # Ensure index is tz-naive
        if self.df_1m.index.tz is not None:
            self.df_1m.index = self.df_1m.index.tz_convert('UTC').tz_localize(None)
            
        # Remove duplicates
        if self.df_1m.index.duplicated().any():
            self.df_1m = self.df_1m[~self.df_1m.index.duplicated(keep='first')]
            
        self.df_1m.sort_index(inplace=True)
        
        # Resample to 3m
        print("Resampling to 3m...")
        self.df_3m = self._resample(self.df_1m, '3min')
        
        # Resample to 4H
        print("Resampling to 4H...")
        self.df_4h = self._resample(self.df_1m, '4h')
        
        print(f"Data prepared. 3m rows: {len(self.df_3m)}, 4H rows: {len(self.df_4h)}")
        
    def _resample(self, df: pd.DataFrame, rule: str) -> pd.DataFrame:
        resampled = df.resample(rule).agg({
            'Open': 'first',
            'High': 'max',
            'Low': 'min',
            'Close': 'last'
        }).dropna()
        return resampled
