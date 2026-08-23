-- Builds the label tables in overture.duckdb from an Overture release: named peaks, lakes and
-- glaciers with the primary name plus the English common name where one exists.
-- Run by basemap.py (`overture` step): duckdb OUT -c ".read overture_labels.sql" with
-- RELEASE substituted. Positions come from the bbox centre, not the geometry, so the scan never
-- touches the geometry column (the expensive part of the parquet); areas are bbox areas in
-- deg^2, which is what the lake/glacier significance ranking and minzoom bands are tuned to.
install httpfs; load httpfs; set s3_region = 'us-west-2';

create or replace table peaks as
select names.primary as name, map_extract(names.common, 'en')[1] as name_en, class, elevation,
       (bbox.xmin + bbox.xmax) / 2 as lon, (bbox.ymin + bbox.ymax) / 2 as lat
from read_parquet('s3://overturemaps-us-west-2/release/RELEASE/theme=base/type=land/*', hive_partitioning = 1)
where class in ('peak', 'volcano') and names.primary is not null;

create or replace table glacier_labels as
select names.primary as name, map_extract(names.common, 'en')[1] as name_en,
       (bbox.xmin + bbox.xmax) / 2 as lon, (bbox.ymin + bbox.ymax) / 2 as lat,
       (bbox.xmax - bbox.xmin) * (bbox.ymax - bbox.ymin) as areadeg
from read_parquet('s3://overturemaps-us-west-2/release/RELEASE/theme=base/type=land/*', hive_partitioning = 1)
where class = 'glacier' and names.primary is not null;

create or replace table lake_labels as
select names.primary as name, map_extract(names.common, 'en')[1] as name_en, subtype,
       (bbox.xmin + bbox.xmax) / 2 as lon, (bbox.ymin + bbox.ymax) / 2 as lat,
       (bbox.xmax - bbox.xmin) * (bbox.ymax - bbox.ymin) as areadeg
from read_parquet('s3://overturemaps-us-west-2/release/RELEASE/theme=base/type=water/*', hive_partitioning = 1)
where subtype in ('lake', 'reservoir') and names.primary is not null;
