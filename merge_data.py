import os
import glob
import pandas as pd
import time

def main():
    data_dir = r"d:\Downloads\python dev\xauusdbot\data"
    csv_files = glob.glob(os.path.join(data_dir, "DAT_NT_XAUUSD_M1_*.csv"))
    csv_files.sort()
    
    print(f"Found {len(csv_files)} CSV files to merge.")
    if not csv_files:
        print("No CSV files found.")
        return
        
    all_dfs = []
    
    start_time = time.time()
    for file in csv_files:
        print(f"Reading {os.path.basename(file)}...")
        df = pd.read_csv(
            file, 
            sep=';', 
            header=None, 
            names=['Timestamp', 'Open', 'High', 'Low', 'Close', 'Volume']
        )
        all_dfs.append(df)
        
    print("Concatenating dataframes...")
    merged_df = pd.concat(all_dfs, ignore_index=True)
    
    print("Converting timestamps...")
    # The format is YYYYMMDD HHMMSS (e.g. 20090315 170000)
    merged_df['Timestamp'] = pd.to_datetime(merged_df['Timestamp'], format='%Y%m%d %H%M%S')
    
    print("Sorting and setting index...")
    merged_df.sort_values('Timestamp', inplace=True)
    merged_df.set_index('Timestamp', inplace=True)
    
    output_path = os.path.join(data_dir, "xauusd_merged.parquet")
    print(f"Saving to Parquet format at {output_path}...")
    merged_df.to_parquet(output_path, engine='pyarrow')
    
    end_time = time.time()
    print(f"Done! Merged {len(merged_df)} rows in {end_time - start_time:.2f} seconds.")

if __name__ == "__main__":
    main()
